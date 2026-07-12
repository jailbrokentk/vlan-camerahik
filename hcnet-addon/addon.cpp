#include <napi.h>
#include <windows.h>
#include <string>
#include <map>
#include <mutex>
#include "HCNetSDK.h"
#include "PlayM4.h"

// Macro to extract HWND from Napi::Value (Buffer or External)
HWND GetHWNDFromValue(const Napi::Value& val) {
    if (val.IsBuffer()) {
        Napi::Buffer<char> buf = val.As<Napi::Buffer<char>>();
        if (buf.Length() >= sizeof(HWND)) {
            return *reinterpret_cast<HWND*>(buf.Data());
        }
    }
    return NULL;
}

// Macro to pack HWND into a Napi::Buffer
Napi::Buffer<char> PackHWND(Napi::Env env, HWND hwnd) {
    Napi::Buffer<char> buf = Napi::Buffer<char>::New(env, sizeof(HWND));
    *reinterpret_cast<HWND*>(buf.Data()) = hwnd;
    return buf;
}

// Global initialization lock
std::mutex g_sdkMutex;
bool g_isInitialized = false;

// ─── Client-side Bitrate & Frame-rate Controller (Tầng C++) ──────────────────

struct StreamStats {
    std::mutex mtx;
    uint64_t byteCount = 0;
    DWORD lastTime = 0;
    double currentKbps = 0.0;
};

// Bản đồ lưu trữ StreamStats cho mỗi previewHandle của LiveView
std::map<LONG, StreamStats*> g_streamStatsMap;
std::mutex g_streamStatsMutex;

// Callback nhận dữ liệu thô (raw byte stream) từ SDK để đo đếm băng thông thực tế
void CALLBACK RealPlayCallBack(LONG lRealPlayHandle, DWORD dwDataType, BYTE *pBuffer, DWORD dwBufSize, void* pUser) {
    std::lock_guard<std::mutex> lock(g_streamStatsMutex);
    auto it = g_streamStatsMap.find(lRealPlayHandle);
    if (it != g_streamStatsMap.end()) {
        StreamStats* stats = it->second;
        std::lock_guard<std::mutex> statsLock(stats->mtx);
        stats->byteCount += dwBufSize;
        
        DWORD now = GetTickCount();
        DWORD elapsed = now - stats->lastTime;
        if (elapsed >= 1000) { // Cập nhật bitrate mỗi 1 giây
            if (elapsed > 0) {
                stats->currentKbps = (double)(stats->byteCount * 8) / elapsed; // Tính Kbps
            }
            stats->byteCount = 0;
            stats->lastTime = now;
        }
    }
}

// ─── Custom Window Class for Input-Transparency ──────────────────────────────

LRESULT CALLBACK RenderWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
        case WM_NCHITTEST:
            return HTTRANSPARENT;
        case WM_MOUSEACTIVATE:
            return MA_NOACTIVATE;
        default:
            return DefWindowProc(hwnd, msg, wParam, lParam);
    }
}

// ─── Global SDK Lifecycle ────────────────────────────────────────────────────

Napi::Value InitSDK(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::lock_guard<std::mutex> lock(g_sdkMutex);

    if (g_isInitialized) {
        return Napi::Boolean::New(env, true);
    }

    BOOL result = NET_DVR_Init();
    if (result) {
        g_isInitialized = true;
        // Set connect and write timeout
        NET_DVR_SetConnectTime(3000, 1);
        NET_DVR_SetReconnect(10000, true);
        // Tối ưu hóa SDK cho mạng LAN tốc độ cao (dwEnvironmentLevel=1)
        // Cho phép SDK sử dụng socket buffer lớn hơn, tăng throughput nhận dữ liệu
        NET_DVR_SetNetworkEnvironment(1);

        // Register custom input-transparent window class
        WNDCLASSEXA wc = {0};
        wc.cbSize = sizeof(WNDCLASSEXA);
        wc.style = CS_HREDRAW | CS_VREDRAW;
        wc.lpfnWndProc = RenderWndProc;
        wc.hInstance = GetModuleHandle(NULL);
        wc.lpszClassName = "HCNetRenderClass";
        RegisterClassExA(&wc);
    }

    return Napi::Boolean::New(env, result == TRUE);
}

Napi::Value CleanupSDK(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::lock_guard<std::mutex> lock(g_sdkMutex);

    if (!g_isInitialized) {
        return Napi::Boolean::New(env, true);
    }

    // Dọn dẹp tất cả các đối tượng StreamStats còn sót lại để tránh rò rỉ bộ nhớ
    {
        std::lock_guard<std::mutex> mapLock(g_streamStatsMutex);
        for (auto& pair : g_streamStatsMap) {
            delete pair.second;
        }
        g_streamStatsMap.clear();
    }

    BOOL result = NET_DVR_Cleanup();
    if (result) {
        g_isInitialized = false;
    }

    return Napi::Boolean::New(env, result == TRUE);
}

// ─── Login Session Management ────────────────────────────────────────────────

Napi::Value LoginDevice(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 4) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string ip = info[0].As<Napi::String>().Utf8Value();
    int port = info[1].As<Napi::Number>().Int32Value();
    std::string username = info[2].As<Napi::String>().Utf8Value();
    std::string password = info[3].As<Napi::String>().Utf8Value();

    NET_DVR_USER_LOGIN_INFO loginInfo = {0};
    loginInfo.bUseAsynLogin = 0;
    strncpy(loginInfo.sDeviceAddress, ip.c_str(), NET_DVR_DEV_ADDRESS_MAX_LEN);
    loginInfo.wPort = port;
    strncpy(loginInfo.sUserName, username.c_str(), NAME_LEN);
    strncpy(loginInfo.sPassword, password.c_str(), PASSWD_LEN);

    NET_DVR_DEVICEINFO_V40 deviceInfo = {0};
    LONG userId = NET_DVR_Login_V40(&loginInfo, &deviceInfo);

    if (userId < 0) {
        // Return object with negative userId so JS can detect failure
        Napi::Object result = Napi::Object::New(env);
        result.Set("userId", Napi::Number::New(env, userId));
        result.Set("sdkChannels", Napi::Array::New(env, 0));
        return result;
    }

    // ─── Build SDK Channel Map ───────────────────────────────────────────────
    // Collect actual HCNetSDK channel numbers the device exposes.
    // These are the values to pass as lChannel to RealPlay/Playback/PTZ.

    Napi::Array sdkChannels = Napi::Array::New(env);
    uint32_t idx = 0;

    const auto& devV30 = deviceInfo.struDeviceV30;

    // 1) Analog channels
    int analogCount = devV30.byChanNum;
    int analogStart = devV30.byStartChan;
    printf("[addon] Device %s — analogStart=%d analogCount=%d\n",
           ip.c_str(), analogStart, analogCount);

    for (int i = 0; i < analogCount; ++i) {
        sdkChannels.Set(idx++, Napi::Number::New(env, analogStart + i));
    }

    // 2) Digital/IP channels via NET_DVR_IPPARACFG_V40
    //    byStartDChan is stored in NET_DVR_DEVICEINFO_V30
    int digitalStart = devV30.byStartDChan;
    int ipChanNumLow = devV30.byIPChanNum;       // low 8 bits of IP channel count
    int ipChanNumHigh = devV30.byHighDChanNum;    // high 8 bits
    int totalDigital = (ipChanNumHigh << 8) | ipChanNumLow;

    printf("[addon] Device %s — digitalStart=%d totalDigital=%d\n",
           ip.c_str(), digitalStart, totalDigital);

    if (totalDigital > 0) {
        // Try getting the IP channel configuration to know which are enabled
        NET_DVR_IPPARACFG_V40 ipConfig = {0};
        ipConfig.dwSize = sizeof(ipConfig);
        DWORD returned = 0;

        BOOL gotConfig = NET_DVR_GetDVRConfig(
            userId,
            NET_DVR_GET_IPPARACFG_V40,
            0,
            &ipConfig,
            sizeof(ipConfig),
            &returned);

        if (gotConfig) {
            printf("[addon] Got IPPARACFG_V40 — dwDChanNum=%lu dwStartDChan=%lu\n",
                   ipConfig.dwDChanNum, ipConfig.dwStartDChan);

            // Use the actual dwStartDChan from ipConfig if available
            int effectiveStart = (ipConfig.dwStartDChan > 0)
                ? (int)ipConfig.dwStartDChan
                : digitalStart;

            // Iterate struStreamMode[] — MAX_CHANNUM_V30 entries
            int maxScan = (totalDigital < MAX_CHANNUM_V30)
                ? totalDigital : MAX_CHANNUM_V30;

            for (int i = 0; i < maxScan; ++i) {
                const auto& stream = ipConfig.struStreamMode[i];
                // byGetStreamType != 0 means a stream source is configured,
                // OR check the underlying channel's byEnable flag
                if (stream.byGetStreamType != 0 ||
                    stream.uGetStream.struChanInfo.byEnable) {
                    int ch = effectiveStart + i;
                    printf("[addon]   IP channel[%d] → sdkChannel=%d (streamType=%d, enable=%d)\n",
                           i, ch,
                           stream.byGetStreamType,
                           stream.uGetStream.struChanInfo.byEnable);
                    sdkChannels.Set(idx++, Napi::Number::New(env, ch));
                }
            }
        } else {
            // Fallback: if GetDVRConfig fails, enumerate all digital channels blindly
            DWORD err = NET_DVR_GetLastError();
            printf("[addon] IPPARACFG_V40 failed (err=%lu), falling back to linear digital channels\n", err);

            for (int i = 0; i < totalDigital; ++i) {
                sdkChannels.Set(idx++, Napi::Number::New(env, digitalStart + i));
            }
        }
    }

    printf("[addon] Login OK — userId=%ld, total sdkChannels=%u\n", userId, idx);

    Napi::Object result = Napi::Object::New(env);
    result.Set("userId", Napi::Number::New(env, userId));
    result.Set("sdkChannels", sdkChannels);
    return result;
}

Napi::Value LogoutDevice(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    LONG userId = info[0].As<Napi::Number>().Int32Value();
    BOOL result = NET_DVR_Logout(userId);

    return Napi::Boolean::New(env, result == TRUE);
}

// ─── Live View ───────────────────────────────────────────────────────────────

Napi::Value StartRealPlay(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 8) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    HWND parentHwnd = GetHWNDFromValue(info[0]);
    LONG userId = info[1].As<Napi::Number>().Int32Value();
    int channelId = info[2].As<Napi::Number>().Int32Value();
    int streamType = info[3].As<Napi::Number>().Int32Value(); // 0: Main, 1: Sub
    int x = info[4].As<Napi::Number>().Int32Value();
    int y = info[5].As<Napi::Number>().Int32Value();
    int w = info[6].As<Napi::Number>().Int32Value();
    int h = info[7].As<Napi::Number>().Int32Value();

    bool enableSmart = false;
    if (info.Length() >= 9) {
        enableSmart = info[8].As<Napi::Boolean>().Value();
    }

    int linkMode = 0; // 0: TCP, 1: UDP
    if (info.Length() >= 10 && !info[9].IsUndefined()) {
        linkMode = info[9].As<Napi::Number>().Int32Value();
    }

    int bufNum = 3; // Default 3 frames buffer for low latency
    if (info.Length() >= 11 && !info[10].IsUndefined()) {
        bufNum = info[10].As<Napi::Number>().Int32Value();
    }

    int previewModeOverride = -1; // -1: Auto
    if (info.Length() >= 12 && !info[11].IsUndefined()) {
        previewModeOverride = info[11].As<Napi::Number>().Int32Value();
    }

    int initialDecodeFrameType = 0; // 0: Full-frame, 1: I-Frame only
    if (info.Length() >= 13 && !info[12].IsUndefined()) {
        initialDecodeFrameType = info[12].As<Napi::Number>().Int32Value();
    }

    if (!parentHwnd) {
        Napi::Error::New(env, "Invalid parent HWND").ThrowAsJavaScriptException();
        return env.Null();
    }

    // Ensure parent window has WS_CLIPCHILDREN to prevent it from painting over the child window and causing flicker
    LONG parentStyle = GetWindowLong(parentHwnd, GWL_STYLE);
    if (!(parentStyle & WS_CLIPCHILDREN)) {
        SetWindowLong(parentHwnd, GWL_STYLE, parentStyle | WS_CLIPCHILDREN);
    }

    // Create native Win32 child window for PlayM4 rendering
    HWND childHwnd = CreateWindowEx(
        WS_EX_NOACTIVATE,
        "HCNetRenderClass",
        NULL,
        WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
        x, y, w, h,
        parentHwnd,
        NULL,
        GetModuleHandle(NULL),
        NULL
    );

    if (!childHwnd) {
        Napi::Error::New(env, "Failed to create child window").ThrowAsJavaScriptException();
        return env.Null();
    }

    NET_DVR_PREVIEWINFO previewInfo = {0};
    previewInfo.lChannel = channelId;
    previewInfo.dwStreamType = streamType;
    previewInfo.dwLinkMode = linkMode; // TCP (0) or UDP (1)
    previewInfo.hPlayWnd = childHwnd; // PlayM4 decodes and renders directly to this HWND
    previewInfo.bBlocked = 1;
    previewInfo.bPassbackRecord = enableSmart ? 1 : 0;
    previewInfo.byRecvMetaData = enableSmart ? 1 : 0;
    previewInfo.byProtoType = 0; // Private protocol
    previewInfo.byVideoCodingType = 0; // Standard video stream
    // Áp dụng previewModeOverride (nhận từ JS để bóp băng thông I-Frame từ gốc NVR truyền về Client)
    if (previewModeOverride >= 0) {
        previewInfo.byPreviewMode = previewModeOverride;
    } else {
        previewInfo.byPreviewMode = (linkMode == 0) ? 0 : ((bufNum <= 4) ? 1 : 0);
    }

    printf("[addon] RealPlay — userId=%ld lChannel=%d dwStreamType=%d enableSmart=%d linkMode=%d bufNum=%d rect=(%d,%d,%d,%d)\n",
           userId, channelId, streamType, enableSmart ? 1 : 0, linkMode, bufNum, x, y, w, h);

    if (channelId <= 0) {
        DestroyWindow(childHwnd);
        Napi::Error::New(env, "Invalid SDK channel number (<=0)").ThrowAsJavaScriptException();
        return env.Null();
    }

    LONG previewHandle = NET_DVR_RealPlay_V40(userId, &previewInfo, RealPlayCallBack, NULL);

    if (previewHandle < 0) {
        DWORD sdkErr = NET_DVR_GetLastError();
        printf("[addon] RealPlay FAILED — lChannel=%d sdkError=%lu\n", channelId, sdkErr);
        DestroyWindow(childHwnd);
        return Napi::Number::New(env, previewHandle); // Return error code
    }

    // Thiết lập số lượng khung hình đệm nhận dữ liệu từ mạng (RAM)
    // Giới hạn trong khoảng [1, 15] để tránh ngốn RAM khi mở nhiều ô camera cùng lúc
    int effectiveBufNum = bufNum;
    if (effectiveBufNum < 1) effectiveBufNum = 1;
    if (effectiveBufNum > 15) effectiveBufNum = 15;
    
    BOOL setBufOk = NET_DVR_SetPlayerBufNumber(previewHandle, effectiveBufNum);
    printf("[addon] NET_DVR_SetPlayerBufNumber handle=%ld bufNum=%d result=%d\n", 
           previewHandle, effectiveBufNum, setBufOk);

    LONG playPort = NET_DVR_GetRealPlayerIndex(previewHandle);
    if (playPort >= 0) {
        // Luôn sử dụng STREAME_REALTIME (0) để giải phóng RAM ngay sau khi hiển thị, không dùng STREAME_FILE (1)
        PlayM4_SetStreamOpenMode(playPort, 0); 
        PlayM4_SetDisplayType(playPort, 5); // DISPLAY_NORMAL | DISPLAY_YC_SCALE
        PlayM4_SetPicQuality(playPort, TRUE); // Chất lượng hình ảnh cao nhất
        
        // Luôn giải mã Full-frame (không bóp khung hình, chỉ bóp bitrate tại nguồn)
        printf("[addon] LiveView PlayCtrl port=%ld configured in Realtime Mode for handle=%ld\n", playPort, previewHandle);
    }

    // Explicitly toggle rendering of VCA rules and motion detection overlays
    NET_DVR_RenderPrivateData(previewHandle, RENDER_ANA_INTEL_DATA, enableSmart ? TRUE : FALSE);
    NET_DVR_RenderPrivateData(previewHandle, RENDER_MD, enableSmart ? TRUE : FALSE);

    // Khởi tạo stats lưu trữ trong bản đồ để đo đếm bitrate cho luồng LiveView mới
    {
        std::lock_guard<std::mutex> lock(g_streamStatsMutex);
        StreamStats* stats = new StreamStats();
        stats->lastTime = GetTickCount();
        stats->byteCount = 0;
        stats->currentKbps = 0.0;
        g_streamStatsMap[previewHandle] = stats;
    }

    printf("[addon] Stream STARTED — handle=%ld ch=%d type=%s bufNum=%d\n", 
           previewHandle, channelId, streamType == 0 ? "HD" : "SD", effectiveBufNum);

    Napi::Object result = Napi::Object::New(env);
    result.Set("previewHandle", Napi::Number::New(env, previewHandle));
    result.Set("childHwnd", PackHWND(env, childHwnd));

    return result;
}

Napi::Value StopRealPlay(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    LONG previewHandle = info[0].As<Napi::Number>().Int32Value();
    HWND childHwnd = GetHWNDFromValue(info[1]);

    BOOL stopResult = FALSE;
    if (previewHandle >= 0) {
        // Dừng kéo luồng từ NVR trước để SDK ngắt hoàn toàn việc gọi callback RealPlayCallBack
        stopResult = NET_DVR_StopRealPlay(previewHandle);
        
        // Sau đó mới an toàn dọn dẹp và giải phóng bộ nhớ StreamStats
        {
            std::lock_guard<std::mutex> lock(g_streamStatsMutex);
            auto it = g_streamStatsMap.find(previewHandle);
            if (it != g_streamStatsMap.end()) {
                delete it->second;
                g_streamStatsMap.erase(it);
            }
        }
    }

    if (childHwnd) {
        DestroyWindow(childHwnd);
    }

    return Napi::Boolean::New(env, stopResult == TRUE);
}

Napi::Value MoveRealPlayWindow(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 5) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    HWND childHwnd = GetHWNDFromValue(info[0]);
    int x = info[1].As<Napi::Number>().Int32Value();
    int y = info[2].As<Napi::Number>().Int32Value();
    int w = info[3].As<Napi::Number>().Int32Value();
    int h = info[4].As<Napi::Number>().Int32Value();

    BOOL result = FALSE;
    if (childHwnd) {
        result = MoveWindow(childHwnd, x, y, w, h, TRUE);
    }

    return Napi::Boolean::New(env, result == TRUE);
}

// ─── Playback ────────────────────────────────────────────────────────────────

Napi::Value StartPlaybackByTime(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 9) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    HWND parentHwnd = GetHWNDFromValue(info[0]);
    LONG userId = info[1].As<Napi::Number>().Int32Value();
    int channelId = info[2].As<Napi::Number>().Int32Value();
    
    // Parse time parameters
    Napi::Object startObj = info[3].As<Napi::Object>();
    Napi::Object endObj = info[4].As<Napi::Object>();

    int x = info[5].As<Napi::Number>().Int32Value();
    int y = info[6].As<Napi::Number>().Int32Value();
    int w = info[7].As<Napi::Number>().Int32Value();
    int h = info[8].As<Napi::Number>().Int32Value();

    if (!parentHwnd) {
        Napi::Error::New(env, "Invalid parent HWND").ThrowAsJavaScriptException();
        return env.Null();
    }

    // Ensure parent window has WS_CLIPCHILDREN to prevent it from painting over the child window and causing flicker
    LONG parentStyle = GetWindowLong(parentHwnd, GWL_STYLE);
    if (!(parentStyle & WS_CLIPCHILDREN)) {
        SetWindowLong(parentHwnd, GWL_STYLE, parentStyle | WS_CLIPCHILDREN);
    }

    HWND childHwnd = CreateWindowEx(
        WS_EX_NOACTIVATE,
        "HCNetRenderClass",
        NULL,
        WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
        x, y, w, h,
        parentHwnd,
        NULL,
        GetModuleHandle(NULL),
        NULL
    );

    if (!childHwnd) {
        Napi::Error::New(env, "Failed to create playback child window").ThrowAsJavaScriptException();
        return env.Null();
    }

    NET_DVR_TIME startTime = {0};
    startTime.dwYear = startObj.Get("year").As<Napi::Number>().Uint32Value();
    startTime.dwMonth = startObj.Get("month").As<Napi::Number>().Uint32Value();
    startTime.dwDay = startObj.Get("day").As<Napi::Number>().Uint32Value();
    startTime.dwHour = startObj.Get("hour").As<Napi::Number>().Uint32Value();
    startTime.dwMinute = startObj.Get("minute").As<Napi::Number>().Uint32Value();
    startTime.dwSecond = startObj.Get("second").As<Napi::Number>().Uint32Value();

    NET_DVR_TIME endTime = {0};
    endTime.dwYear = endObj.Get("year").As<Napi::Number>().Uint32Value();
    endTime.dwMonth = endObj.Get("month").As<Napi::Number>().Uint32Value();
    endTime.dwDay = endObj.Get("day").As<Napi::Number>().Uint32Value();
    endTime.dwHour = endObj.Get("hour").As<Napi::Number>().Uint32Value();
    endTime.dwMinute = endObj.Get("minute").As<Napi::Number>().Uint32Value();
    endTime.dwSecond = endObj.Get("second").As<Napi::Number>().Uint32Value();

    // In PlaybackTime preview, Hikvision uses channel 101/201 etc.
    LONG playbackHandle = NET_DVR_PlayBackByTime(userId, channelId, &startTime, &endTime, childHwnd);

    if (playbackHandle < 0) {
        DestroyWindow(childHwnd);
        return Napi::Number::New(env, playbackHandle); // Return error code
    }

    // Call PlayBackControl to start playing immediately
    DWORD ret = 0;
    NET_DVR_PlayBackControl_V40(playbackHandle, NET_DVR_PLAYSTART, NULL, 0, NULL, &ret);

    // Force seek to startTime to bypass NVRs that ignore startTime parameter in PlayBackByTime
    NET_DVR_PlayBackControl_V40(playbackHandle, 11, &startTime, sizeof(startTime), NULL, &ret);

    LONG playPort = NET_DVR_GetPlayBackPlayerIndex(playbackHandle);
    if (playPort >= 0) {
        PlayM4_SetStreamOpenMode(playPort, 1); // 1 = STREAME_FILE (File mode for playback to keep all frames chronologically)
        PlayM4_SetDisplayType(playPort, 5); // 5 = DISPLAY_NORMAL (1) | DISPLAY_YC_SCALE (4) for bilinear scaling
        PlayM4_SetPicQuality(playPort, TRUE); // High quality picture quality
        printf("[addon] Playback D3D render, File Mode and High Quality enabled for playback handle=%ld port=%ld\n", playbackHandle, playPort);
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("playbackHandle", Napi::Number::New(env, playbackHandle));
    result.Set("childHwnd", PackHWND(env, childHwnd));

    return result;
}

Napi::Value StopPlayback(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    LONG playbackHandle = info[0].As<Napi::Number>().Int32Value();
    HWND childHwnd = GetHWNDFromValue(info[1]);

    BOOL stopResult = FALSE;
    if (playbackHandle >= 0) {
        stopResult = NET_DVR_StopPlayBack(playbackHandle);
    }

    if (childHwnd) {
        DestroyWindow(childHwnd);
    }

    return Napi::Boolean::New(env, stopResult == TRUE);
}

Napi::Value GetPlaybackTime(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    LONG playbackHandle = info[0].As<Napi::Number>().Int32Value();
    NET_DVR_TIME devTime = {0};
    DWORD outLen = sizeof(devTime);
    DWORD ret = 0;

    BOOL result = NET_DVR_PlayBackControl_V40(playbackHandle, 14, NULL, 0, &devTime, &outLen); // 14 = NET_DVR_PLAYGETTIME
    if (!result) {
        return env.Null();
    }

    Napi::Object timeObj = Napi::Object::New(env);
    timeObj.Set("year", Napi::Number::New(env, devTime.dwYear));
    timeObj.Set("month", Napi::Number::New(env, devTime.dwMonth));
    timeObj.Set("day", Napi::Number::New(env, devTime.dwDay));
    timeObj.Set("hour", Napi::Number::New(env, devTime.dwHour));
    timeObj.Set("minute", Napi::Number::New(env, devTime.dwMinute));
    timeObj.Set("second", Napi::Number::New(env, devTime.dwSecond));

    return timeObj;
}

Napi::Value SeekPlaybackTime(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    LONG playbackHandle = info[0].As<Napi::Number>().Int32Value();
    Napi::Object timeObj = info[1].As<Napi::Object>();

    NET_DVR_TIME targetTime = {0};
    targetTime.dwYear = timeObj.Get("year").As<Napi::Number>().Uint32Value();
    targetTime.dwMonth = timeObj.Get("month").As<Napi::Number>().Uint32Value();
    targetTime.dwDay = timeObj.Get("day").As<Napi::Number>().Uint32Value();
    targetTime.dwHour = timeObj.Get("hour").As<Napi::Number>().Uint32Value();
    targetTime.dwMinute = timeObj.Get("minute").As<Napi::Number>().Uint32Value();
    targetTime.dwSecond = timeObj.Get("second").As<Napi::Number>().Uint32Value();

    DWORD ret = 0;
    // Try NET_DVR_PLAYSEEKTIME (26) first — newer V40 seek API
    BOOL result = NET_DVR_PlayBackControl_V40(playbackHandle, 26, &targetTime, sizeof(targetTime), NULL, &ret);

    // Fallback to NET_DVR_PLAYSETTIME (11) if PLAYSEEKTIME is not supported by firmware
    if (!result) {
        printf("[addon] PLAYSEEKTIME (26) failed (err=%lu), falling back to PLAYSETTIME (11)\n", NET_DVR_GetLastError());
        result = NET_DVR_PlayBackControl_V40(playbackHandle, 11, &targetTime, sizeof(targetTime), NULL, &ret);
    }

    return Napi::Boolean::New(env, result == TRUE);
}

Napi::Value ControlPlayback(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    LONG playbackHandle = info[0].As<Napi::Number>().Int32Value();
    DWORD cmd = info[1].As<Napi::Number>().Uint32Value();
    DWORD param = info[2].As<Napi::Number>().Uint32Value();

    DWORD ret = 0;
    BOOL result = NET_DVR_PlayBackControl_V40(playbackHandle, cmd, &param, sizeof(param), NULL, &ret);

    return Napi::Boolean::New(env, result == TRUE);
}

Napi::Value GetPlaybackProgress(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    LONG playbackHandle = info[0].As<Napi::Number>().Int32Value();
    DWORD dwPos = 0;
    DWORD outLen = sizeof(dwPos);
    // NET_DVR_PLAYGETPOS = 13
    BOOL result = NET_DVR_PlayBackControl_V40(playbackHandle, 13, NULL, 0, &dwPos, &outLen);
    if (!result) {
        return Napi::Number::New(env, -1);
    }
    return Napi::Number::New(env, (int)dwPos);
}

Napi::Value SetPlaybackAudio(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    LONG playbackHandle = info[0].As<Napi::Number>().Int32Value();
    bool enable = info[1].As<Napi::Boolean>().Value();
    // NET_DVR_PLAYSTARTAUDIO = 9, NET_DVR_PLAYSTOPAUDIO = 10
    DWORD cmd = enable ? 9 : 10;
    DWORD ret = 0;
    BOOL result = NET_DVR_PlayBackControl_V40(playbackHandle, cmd, NULL, 0, NULL, &ret);
    return Napi::Boolean::New(env, result == TRUE);
}

Napi::Value CapturePlaybackPicture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    LONG playbackHandle = info[0].As<Napi::Number>().Int32Value();
    std::string sPicFileName = info[1].As<Napi::String>().Utf8Value();

    char filename[512] = {0};
    strncpy(filename, sPicFileName.c_str(), sizeof(filename) - 1);

    BOOL result = NET_DVR_PlayBackCaptureFile(playbackHandle, filename);
    return Napi::Boolean::New(env, result == TRUE);
}

// ─── PTZ Control ─────────────────────────────────────────────────────────────


Napi::Value PTZControl(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    LONG userId = info[0].As<Napi::Number>().Int32Value();
    int channelId = info[1].As<Napi::Number>().Int32Value();
    DWORD command = info[2].As<Napi::Number>().Uint32Value();
    DWORD stop = info[3].As<Napi::Number>().Uint32Value(); // 0: Start, 1: Stop

    BOOL result = NET_DVR_PTZControl_Other(userId, channelId, command, stop);

    return Napi::Boolean::New(env, result == TRUE);
}

// ─── Diagnostics & Errors ────────────────────────────────────────────────────

Napi::Value GetLastSDKError(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    DWORD error = NET_DVR_GetLastError();
    return Napi::Number::New(env, error);
}

// ─── Window Visibility Control ───────────────────────────────────────────────

Napi::Value SetWindowVisible(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }
    HWND childHwnd = GetHWNDFromValue(info[0]);
    bool visible = info[1].As<Napi::Boolean>().Value();

    BOOL result = FALSE;
    if (childHwnd) {
        result = ShowWindow(childHwnd, visible ? SW_SHOW : SW_HIDE);
    }
    return Napi::Boolean::New(env, result == TRUE);
}

// ─── Private Data Rendering Control ──────────────────────────────────────────

Napi::Value SetRenderPrivateData(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }
    LONG previewHandle = info[0].As<Napi::Number>().Int32Value();
    bool enableSmart = info[1].As<Napi::Boolean>().Value();

    // Third parameter (optional): isPlayback — distinguishes LiveView vs Playback handle
    bool isPlayback = false;
    if (info.Length() >= 3) {
        isPlayback = info[2].As<Napi::Boolean>().Value();
    }

    BOOL result = FALSE;
    if (previewHandle >= 0) {
        if (isPlayback) {
            // ─── Playback handle: use PlayBackControl_V40 VCA commands ───
            // RenderPrivateData is LiveView-only and returns FALSE for playback handles.
            DWORD ret = 0;
            DWORD vcaCmd = enableSmart ? 45 : 46; // NET_DVR_PLAY_START_DEC_VCA / NET_DVR_PLAY_STOP_DEC_VCA
            result = NET_DVR_PlayBackControl_V40(previewHandle, vcaCmd, NULL, 0, NULL, &ret);
            printf("[addon] Playback VCA %s — handle=%ld cmd=%lu result=%d\n",
                   enableSmart ? "START" : "STOP", previewHandle, vcaCmd, result);

            if (!enableSmart && result) {
                // After stopping VCA decoding, the already-drawn overlay persists on the
                // native window's device context. Force a frame refresh to clear it.
                NET_DVR_PlayBackControl_V40(previewHandle, 15, NULL, 0, NULL, &ret); // NET_DVR_PLAYREFRESH = 15
            }
        } else {
            // ─── LiveView handle: use RenderPrivateData ───
            BOOL r1 = NET_DVR_RenderPrivateData(previewHandle, RENDER_ANA_INTEL_DATA, enableSmart ? TRUE : FALSE);
            BOOL r2 = NET_DVR_RenderPrivateData(previewHandle, RENDER_MD, enableSmart ? TRUE : FALSE);
            result = r1 && r2;
        }
    }
    return Napi::Boolean::New(env, result == TRUE);
}

// ─── Native Audio Control ────────────────────────────────────────────────────

Napi::Value SetAudioEnabled(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }
    LONG previewHandle = info[0].As<Napi::Number>().Int32Value();
    bool enabled = info[1].As<Napi::Boolean>().Value();

    BOOL result = FALSE;
    if (previewHandle >= 0) {
        if (enabled) {
            NET_DVR_CloseSound();
            result = NET_DVR_OpenSound(previewHandle);
        } else {
            result = NET_DVR_CloseSound();
        }
    }
    return Napi::Boolean::New(env, result == TRUE);
}

// ─── Playback Window Clipping Control ───────────────────────────────────────

Napi::Value SetPlaybackWindowClip(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 5) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }
    HWND childHwnd = GetHWNDFromValue(info[0]);
    int left = info[1].As<Napi::Number>().Int32Value();
    int top = info[2].As<Napi::Number>().Int32Value();
    int right = info[3].As<Napi::Number>().Int32Value();
    int bottom = info[4].As<Napi::Number>().Int32Value();

    BOOL result = FALSE;
    if (childHwnd) {
        if (left == 0 && top == 0 && right == 0 && bottom == 0) {
            // Remove clipping region
            result = SetWindowRgn(childHwnd, NULL, TRUE);
        } else {
            // Apply rectangular clipping region relative to child window coordinate system
            HRGN hRgn = CreateRectRgn(left, top, right, bottom);
            if (hRgn) {
                result = SetWindowRgn(childHwnd, hRgn, TRUE);
                if (!result) {
                    DeleteObject(hRgn); // Prevent GDI handle leak if SetWindowRgn fails
                }
            }
        }
    }
    return Napi::Boolean::New(env, result == TRUE);
}

Napi::Value RedrawWindowNative(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }
    HWND childHwnd = GetHWNDFromValue(info[0]);
    BOOL result = FALSE;
    if (childHwnd) {
        // FALSE prevents erasing the background (prevents visual flickering/flashing)
        InvalidateRect(childHwnd, NULL, FALSE);
        result = UpdateWindow(childHwnd);
    }
    return Napi::Boolean::New(env, result == TRUE);
}



// getStreamBitrate(previewHandle) -> Trả về bitrate hiện tại dạng Kbps (double)
Napi::Value GetStreamBitrate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) {
        Napi::TypeError::New(env, "GetStreamBitrate requires 1 arg: previewHandle").ThrowAsJavaScriptException();
        return env.Null();
    }
    LONG previewHandle = info[0].As<Napi::Number>().Int32Value();
    double kbps = 0.0;
    {
        std::lock_guard<std::mutex> lock(g_streamStatsMutex);
        auto it = g_streamStatsMap.find(previewHandle);
        if (it != g_streamStatsMap.end()) {
            StreamStats* stats = it->second;
            std::lock_guard<std::mutex> statsLock(stats->mtx);
            // Cập nhật cưỡng bức nếu khoảng trễ quá 1 giây mà chưa có callback mới kích hoạt
            DWORD now = GetTickCount();
            DWORD elapsed = now - stats->lastTime;
            if (elapsed >= 1000) {
                if (elapsed > 0) {
                    stats->currentKbps = (double)(stats->byteCount * 8) / elapsed;
                }
                stats->byteCount = 0;
                stats->lastTime = now;
            }
            kbps = stats->currentKbps;
        }
    }
    return Napi::Number::New(env, kbps);
}

// setDecodeFrameType(previewHandle, nFrameType) -> Khống chế giải mã tại Client
// nFrameType: 0 = Decode all frames (Full-frame), 1 = Decode I-frame only (Keyframe only)
Napi::Value SetDecodeFrameType(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "SetDecodeFrameType requires 2 args: previewHandle, nFrameType").ThrowAsJavaScriptException();
        return env.Null();
    }
    LONG previewHandle = info[0].As<Napi::Number>().Int32Value();
    DWORD nFrameType = info[1].As<Napi::Number>().Uint32Value();

    BOOL result = FALSE;
    if (previewHandle >= 0) {
        LONG playPort = NET_DVR_GetRealPlayerIndex(previewHandle);
        if (playPort >= 0) {
            // PlayM4_SetDecodeFrameType: 0 - full-frame, 2 - I-frame only (Hikvision PlayCtrl dùng 2 cho I-frame)
            // Lưu ý: SDK Hikvision PlayM4 định nghĩa: 0-all frames, 1-I/P frames, 2-I-frame only
            // Nên nếu JS truyền mode 1 (I-Frame only) ta map thành 2 cho PlayCtrl
            DWORD playCtrlFrameType = (nFrameType == 1) ? 2 : 0;
            result = PlayM4_SetDecodeFrameType(playPort, playCtrlFrameType);
        }
    }
    return Napi::Boolean::New(env, result == TRUE);
}

// ─── Addon Initialization ────────────────────────────────────────────────────

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("init", Napi::Function::New(env, InitSDK));
    exports.Set("cleanup", Napi::Function::New(env, CleanupSDK));
    exports.Set("login", Napi::Function::New(env, LoginDevice));
    exports.Set("logout", Napi::Function::New(env, LogoutDevice));
    exports.Set("startRealPlay", Napi::Function::New(env, StartRealPlay));
    exports.Set("stopRealPlay", Napi::Function::New(env, StopRealPlay));
    exports.Set("moveRealPlayWindow", Napi::Function::New(env, MoveRealPlayWindow));
    exports.Set("setWindowVisible", Napi::Function::New(env, SetWindowVisible));
    exports.Set("setRenderPrivateData", Napi::Function::New(env, SetRenderPrivateData));
    exports.Set("setAudioEnabled", Napi::Function::New(env, SetAudioEnabled));
    exports.Set("startPlaybackByTime", Napi::Function::New(env, StartPlaybackByTime));
    exports.Set("stopPlayback", Napi::Function::New(env, StopPlayback));
    exports.Set("controlPlayback", Napi::Function::New(env, ControlPlayback));
    exports.Set("getPlaybackTime", Napi::Function::New(env, GetPlaybackTime));
    exports.Set("seekPlaybackTime", Napi::Function::New(env, SeekPlaybackTime));
    exports.Set("getPlaybackProgress", Napi::Function::New(env, GetPlaybackProgress));
    exports.Set("setPlaybackAudio", Napi::Function::New(env, SetPlaybackAudio));
    exports.Set("setPlaybackWindowClip", Napi::Function::New(env, SetPlaybackWindowClip));
    exports.Set("redrawWindow", Napi::Function::New(env, RedrawWindowNative));
    exports.Set("capturePlaybackPicture", Napi::Function::New(env, CapturePlaybackPicture));
    exports.Set("ptzControl", Napi::Function::New(env, PTZControl));
    exports.Set("getStreamBitrate", Napi::Function::New(env, GetStreamBitrate));
    exports.Set("setDecodeFrameType", Napi::Function::New(env, SetDecodeFrameType));

    exports.Set("getLastError", Napi::Function::New(env, GetLastSDKError));
    return exports;
}

NODE_API_MODULE(hcnet_addon, Init)
