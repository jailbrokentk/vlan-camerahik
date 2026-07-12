#include <windows.h>
#include <string>
#include <map>
#include <mutex>
#include <vector>
#include <iostream>

// Định nghĩa cấu trúc đăng nhập của Hikvision SDK
struct NET_DVR_USER_LOGIN_INFO {
    char sDeviceAddress[129];
    BYTE byUseWpp;
    WORD wDVRPort;
    char sUserName[64];
    char sPassword[64];
    void (*fLoginResultCallBack)(LONG lUserID, DWORD dwResult, void* lpDeviceInfo, void* pUser);
    void* pUser;
    BOOL bUseAsynLogin;
    BYTE byProxyType;
    BYTE byUseProxy;
    WORD wProxyPort;
    char sProxyIP[64];
    char sProxyUserName[64];
    char sProxyPassword[64];
    BYTE byLoginMode;
    BYTE byHttps;
    BYTE byRes2[2];
    DWORD dwTimeout;
};

struct NET_DVR_PREVIEWINFO {
    LONG lChannel;
    DWORD dwStreamType;
    DWORD dwLinkMode;
    HWND hPlayWnd;
    BOOL bBlocked;
    BOOL bPassbackRecord;
    BYTE byPreviewMode;
    BYTE byProtoType;
    BYTE byRes1[2];
    BYTE byVideoFormat;
    BYTE byDisplayBufNum;
    BYTE byRes2[24];
};

struct DeviceInfo {
    std::string ip;
    int port;
    std::string username;
    std::string password;
};

struct StreamInfo {
    LONG userId;
    LONG channel;
    DWORD streamType;
    HWND hPlayWnd;
};

// Bản đồ lưu trữ thông tin chụp được
std::map<LONG, DeviceInfo> g_deviceMap; // userId -> DeviceInfo
std::map<LONG, StreamInfo> g_streamMap; // previewHandle -> StreamInfo
std::mutex g_dataMutex;

// SDK function pointers
typedef LONG(WINAPI* LPFN_NET_DVR_Login_V40)(NET_DVR_USER_LOGIN_INFO* pLoginInfo, void* lpDeviceInfo);
typedef LONG(WINAPI* LPFN_NET_DVR_RealPlay_V40)(LONG lUserID, NET_DVR_PREVIEWINFO* lpPreviewInfo, void* fRealPlayCallBack, void* pUser);
typedef BOOL(WINAPI* LPFN_NET_DVR_StopRealPlay)(LONG lRealPlayHandle);

LPFN_NET_DVR_Login_V40 g_orig_Login = nullptr;
LPFN_NET_DVR_RealPlay_V40 g_orig_RealPlay = nullptr;
LPFN_NET_DVR_StopRealPlay g_orig_StopRealPlay = nullptr;

// Inline Hook helper class
class InlineHook {
public:
    void* targetFunc = nullptr;
    void* hookFunc = nullptr;
    BYTE originalBytes[12] = { 0 };
    bool isHooked = false;

    void Setup(void* target, void* hook) {
        targetFunc = target;
        hookFunc = hook;
    }

    void Hook() {
        if (isHooked || !targetFunc || !hookFunc) return;
        
        DWORD oldProtect;
        VirtualProtect(targetFunc, 12, PAGE_EXECUTE_READWRITE, &oldProtect);

        // Lưu 5 byte gốc (hoặc 12 byte đối với x64)
#ifdef _WIN64
        memcpy(originalBytes, targetFunc, 12);
        // jmp [rip + 0] -> FF 25 00 00 00 00 [64-bit Address]
        BYTE jmpBytes[12] = { 0xFF, 0x25, 0x00, 0x00, 0x00, 0x00 };
        *reinterpret_cast<void**>(&jmpBytes[6]) = hookFunc;
        memcpy(targetFunc, jmpBytes, 12);
#else
        memcpy(originalBytes, targetFunc, 5);
        // jmp relative
        BYTE jmpBytes[5] = { 0xE9 };
        DWORD relativeAddr = (DWORD)hookFunc - (DWORD)targetFunc - 5;
        *reinterpret_cast<DWORD*>(&jmpBytes[1]) = relativeAddr;
        memcpy(targetFunc, jmpBytes, 5);
#endif

        VirtualProtect(targetFunc, 12, oldProtect, &oldProtect);
        isHooked = true;
    }

    void Unhook() {
        if (!isHooked || !targetFunc) return;

        DWORD oldProtect;
        VirtualProtect(targetFunc, 12, PAGE_EXECUTE_READWRITE, &oldProtect);
#ifdef _WIN64
        memcpy(targetFunc, originalBytes, 12);
#else
        memcpy(targetFunc, originalBytes, 5);
#endif
        VirtualProtect(targetFunc, 12, oldProtect, &oldProtect);
        isHooked = false;
    }
};

InlineHook g_hookLogin;
InlineHook g_hookRealPlay;
InlineHook g_hookStopRealPlay;

// Hook function cho NET_DVR_Login_V40
LONG WINAPI Hooked_NET_DVR_Login_V40(NET_DVR_USER_LOGIN_INFO* pLoginInfo, void* lpDeviceInfo) {
    g_hookLogin.Unhook();
    LONG userId = g_orig_Login(pLoginInfo, lpDeviceInfo);
    g_hookLogin.Hook();

    if (userId >= 0 && pLoginInfo) {
        std::lock_guard<std::mutex> lock(g_dataMutex);
        DeviceInfo dev;
        dev.ip = pLoginInfo->sDeviceAddress;
        dev.port = pLoginInfo->wDVRPort;
        dev.username = pLoginInfo->sUserName;
        dev.password = pLoginInfo->sPassword;
        g_deviceMap[userId] = dev;
    }
    return userId;
}

// Hook function cho NET_DVR_RealPlay_V40
LONG WINAPI Hooked_NET_DVR_RealPlay_V40(LONG lUserID, NET_DVR_PREVIEWINFO* lpPreviewInfo, void* fRealPlayCallBack, void* pUser) {
    g_hookRealPlay.Unhook();
    LONG handle = g_orig_RealPlay(lUserID, lpPreviewInfo, fRealPlayCallBack, pUser);
    g_hookRealPlay.Hook();

    if (handle >= 0 && lpPreviewInfo) {
        std::lock_guard<std::mutex> lock(g_dataMutex);
        StreamInfo stream;
        stream.userId = lUserID;
        stream.channel = lpPreviewInfo->lChannel;
        stream.streamType = lpPreviewInfo->dwStreamType;
        stream.hPlayWnd = lpPreviewInfo->hPlayWnd;
        g_streamMap[handle] = stream;
    }
    return handle;
}

// Hook function cho NET_DVR_StopRealPlay
BOOL WINAPI Hooked_NET_DVR_StopRealPlay(LONG lRealPlayHandle) {
    g_hookStopRealPlay.Unhook();
    BOOL result = g_orig_StopRealPlay(lRealPlayHandle);
    g_hookStopRealPlay.Hook();

    if (result) {
        std::lock_guard<std::mutex> lock(g_dataMutex);
        g_streamMap.erase(lRealPlayHandle);
    }
    return result;
}

// Lớp quản lý Cửa sổ nổi hiển thị camera (Popout Window)
class PopoutPlayer {
public:
    HWND hwnd = NULL;
    LONG previewHandle = -1;

    static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
        PopoutPlayer* self = (PopoutPlayer*)GetWindowLongPtr(hwnd, GWLP_USERDATA);
        switch (msg) {
            case WM_CLOSE: {
                if (self) {
                    if (self->previewHandle >= 0) {
                        g_orig_StopRealPlay(self->previewHandle);
                    }
                    delete self;
                }
                DestroyWindow(hwnd);
                return 0;
            }
            case WM_SIZE: {
                // Tự động điều chỉnh kích thước của luồng hiển thị bên trong cửa sổ nổi
                // (Vì SDK vẽ trực tiếp trên HWND này nên Windows tự điều chỉnh tỷ lệ)
                return 0;
            }
        }
        return DefWindowProc(hwnd, msg, wp, lp);
    }
};

// Hàm mở cửa sổ nổi hiển thị camera độc lập
void OpenPopoutWindow(const DeviceInfo& dev, const StreamInfo& stream) {
    HINSTANCE hInst = GetModuleHandle(NULL);
    
    // Đăng ký lớp cửa sổ nổi nếu chưa đăng ký
    WNDCLASSEXW wc = { sizeof(wc) };
    wc.lpfnWndProc = PopoutPlayer::WndProc;
    wc.hInstance = hInst;
    wc.lpszClassName = L"iVMS_Popout_Player";
    wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
    wc.hCursor = LoadCursor(NULL, IDC_ARROW);
    RegisterClassExW(&wc);

    // Tạo cửa sổ nổi độc lập
    std::wstring title = L"Popout - Camera Ch " + std::to_wstring(stream.channel) + L" (" + std::wstring(dev.ip.begin(), dev.ip.end()) + L")";
    HWND hwndPopout = CreateWindowExW(
        WS_EX_TOPMOST, // Luôn hiển thị trên cùng để tiện theo dõi
        L"iVMS_Popout_Player",
        title.c_str(),
        WS_OVERLAPPEDWINDOW | WS_VISIBLE,
        CW_USEDEFAULT, CW_USEDEFAULT, 640, 360, // Kích thước mặc định 16:9
        NULL, NULL, hInst, NULL
    );

    if (!hwndPopout) return;

    PopoutPlayer* player = new PopoutPlayer();
    player->hwnd = hwndPopout;
    SetWindowLongPtr(hwndPopout, GWLP_USERDATA, (LONG_PTR)player);

    // Thiết lập thông tin preview mới cho cửa sổ nổi
    NET_DVR_PREVIEWINFO previewInfo = { 0 };
    previewInfo.lChannel = stream.channel;
    previewInfo.dwStreamType = 0; // Luôn phát luồng HD (0) khi popout để xem căng nét
    previewInfo.hPlayWnd = hwndPopout; // Vẽ trực tiếp lên cửa sổ nổi Win32 mới tạo
    previewInfo.byPreviewMode = 0;

    // Phát luồng camera song song trên cửa sổ nổi
    player->previewHandle = g_orig_RealPlay(stream.userId, &previewInfo, NULL, NULL);
}

// Thread nền theo dõi Phím nóng (Hotkey) để trigger Popout
DWORD WINAPI HotkeyMonitorThread(LPVOID lpParam) {
    // Đăng ký Hotkey toàn cục cho tiến trình: Ctrl + Shift + P
    RegisterHotKey(NULL, 1, MOD_CONTROL | MOD_SHIFT, 'P');

    MSG msg = { 0 };
    while (GetMessage(&msg, NULL, 0, 0)) {
        if (msg.message == WM_HOTKEY && msg.wParam == 1) {
            // Khi người dùng bấm Ctrl + Shift + P:
            // 1. Tìm cửa sổ con Win32 đang được hover dưới trỏ chuột
            POINT pt;
            GetCursorPos(&pt);
            HWND hwndUnderCursor = WindowFromPoint(pt);

            if (hwndUnderCursor) {
                // 2. Tìm xem HWND này có khớp với ô camera nào đang phát trong iVMS Lite không
                LONG targetHandle = -1;
                StreamInfo targetStream;
                bool found = false;

                {
                    std::lock_guard<std::mutex> lock(g_dataMutex);
                    // Lần lượt kiểm tra xem HWND dưới chuột có khớp với stream active nào không
                    for (const auto& pair : g_streamMap) {
                        HWND parent = hwndUnderCursor;
                        while (parent) {
                            if (parent == pair.second.hPlayWnd) { // Check trùng khớp HWND render của SDK
                                targetHandle = pair.first;
                                targetStream = pair.second;
                                found = true;
                                break;
                            }
                            parent = GetParent(parent);
                        }
                        if (found) break;
                    }
                }

                // 3. Nếu tìm thấy camera đang phát, tiến hành mở cửa sổ nổi Popout!
                if (found) {
                    DeviceInfo dev;
                    bool devFound = false;
                    {
                        std::lock_guard<std::mutex> lock(g_dataMutex);
                        auto it = g_deviceMap.find(targetStream.userId);
                        if (it != g_deviceMap.end()) {
                            dev = it->second;
                            devFound = true;
                        }
                    }

                    if (devFound) {
                        OpenPopoutWindow(dev, targetStream);
                    }
                }
            }
        }
    }
    return 0;
}

// Thread nền để quét và cài đặt Hook khi SDK DLL được nạp
DWORD WINAPI HookInitThread(LPVOID lpParam) {
    HMODULE hSDK = NULL;
    HMODULE hPlay = NULL;

    // Đợi cho đến khi iVMS-4200 Lite load xong các thư viện SDK
    while (!hSDK || !hPlay) {
        hSDK = GetModuleHandleA("HCNetSDK.dll");
        hPlay = GetModuleHandleA("PlayCtrl.dll");
        Sleep(100);
    }

    // Lấy địa chỉ các hàm gốc để hook
    g_orig_Login = (LPFN_NET_DVR_Login_V40)GetProcAddress(hSDK, "NET_DVR_Login_V40");
    g_orig_RealPlay = (LPFN_NET_DVR_RealPlay_V40)GetProcAddress(hSDK, "NET_DVR_RealPlay_V40");
    g_orig_StopRealPlay = (LPFN_NET_DVR_StopRealPlay)GetProcAddress(hSDK, "NET_DVR_StopRealPlay");

    if (g_orig_Login && g_orig_RealPlay && g_orig_StopRealPlay) {
        g_hookLogin.Setup((void*)g_orig_Login, (void*)Hooked_NET_DVR_Login_V40);
        g_hookRealPlay.Setup((void*)g_orig_RealPlay, (void*)Hooked_NET_DVR_RealPlay_V40);
        g_hookStopRealPlay.Setup((void*)g_orig_StopRealPlay, (void*)Hooked_NET_DVR_StopRealPlay);

        g_hookLogin.Hook();
        g_hookRealPlay.Hook();
        g_hookStopRealPlay.Hook();
    }

    // Khởi chạy thread giám sát hotkey
    CreateThread(NULL, 0, HotkeyMonitorThread, NULL, 0, NULL);
    return 0;
}

BOOL APIENTRY DllMain(HMODULE hModule, DWORD ul_reason_for_call, LPVOID lpReserved) {
    switch (ul_reason_for_call) {
        case DLL_PROCESS_ATTACH: {
            DisableThreadLibraryCalls(hModule);
            CreateThread(NULL, 0, HookInitThread, NULL, 0, NULL);
            break;
        }
        case DLL_PROCESS_DETACH: {
            g_hookLogin.Unhook();
            g_hookRealPlay.Unhook();
            g_hookStopRealPlay.Unhook();
            break;
        }
    }
    return TRUE;
}
