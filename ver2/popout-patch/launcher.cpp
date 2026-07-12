#include <windows.h>
#include <iostream>
#include <string>
#include <shlwapi.h>

// Hàm thực hiện tiêm DLL vào tiến trình đích
bool InjectDLL(HANDLE hProcess, const std::wstring& dllPath) {
    size_t dllPathSize = (dllPath.length() + 1) * sizeof(wchar_t);

    // Cấp phát bộ nhớ trong tiến trình đích để ghi đường dẫn DLL
    LPVOID pDllPath = VirtualAllocEx(hProcess, NULL, dllPathSize, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!pDllPath) {
        std::wcerr << L"[Error] VirtualAllocEx failed. Error code: " << GetLastError() << std::endl;
        return false;
    }

    // Ghi đường dẫn DLL vào vùng nhớ vừa cấp phát
    if (!WriteProcessMemory(hProcess, pDllPath, dllPath.c_str(), dllPathSize, NULL)) {
        std::wcerr << L"[Error] WriteProcessMemory failed. Error code: " << GetLastError() << std::endl;
        VirtualFreeEx(hProcess, pDllPath, 0, MEM_RELEASE);
        return false;
    }

    // Lấy địa chỉ của hàm LoadLibraryW trong kernel32.dll
    LPTHREAD_START_ROUTINE pLoadLibrary = (LPTHREAD_START_ROUTINE)GetProcAddress(
        GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW"
    );
    if (!pLoadLibrary) {
        std::wcerr << L"[Error] GetProcAddress for LoadLibraryW failed. Error code: " << GetLastError() << std::endl;
        VirtualFreeEx(hProcess, pDllPath, 0, MEM_RELEASE);
        return false;
    }

    // Tạo luồng từ xa để gọi LoadLibraryW trong tiến trình đích
    HANDLE hThread = CreateRemoteThread(hProcess, NULL, 0, pLoadLibrary, pDllPath, 0, NULL);
    if (!hThread) {
        std::wcerr << L"[Error] CreateRemoteThread failed. Error code: " << GetLastError() << std::endl;
        VirtualFreeEx(hProcess, pDllPath, 0, MEM_RELEASE);
        return false;
    }

    // Chờ luồng tiêm DLL thực thi xong
    WaitForSingleObject(hThread, INFINITE);

    // Dọn dẹp tài nguyên
    CloseHandle(hThread);
    VirtualFreeEx(hProcess, pDllPath, 0, MEM_RELEASE);
    return true;
}

int main() {
    std::wcout << L"========================================" << std::endl;
    std::wcout << L"   iVMS-4200 Lite Popout Launcher v2.0  " << std::endl;
    std::wcout << L"========================================" << std::endl;

    // Lấy đường dẫn thư mục hiện tại của Launcher
    wchar_t buffer[MAX_PATH];
    GetModuleFileNameW(NULL, buffer, MAX_PATH);
    std::wstring exePath(buffer);
    std::wstring dirPath = exePath.substr(0, exePath.find_last_of(L"\\/"));

    // Xác định đường dẫn file iVMS-4200 Lite.exe và iVMS_Popout.dll
    std::wstring appPath = dirPath + L"\\iVMS-4200 Lite.exe";
    std::wstring dllPath = dirPath + L"\\iVMS_Popout.dll";

    // Nếu không tìm thấy trong thư mục hiện tại, kiểm tra đường dẫn cài đặt mặc định
    if (!PathFileExistsW(appPath.c_str())) {
        std::wstring defaultPath1 = L"C:\\Program Files (x86)\\iVMS-4200 Site\\iVMS-4200 Portal\\iVMS-4200 Lite.exe";
        std::wstring defaultPath2 = L"C:\\Program Files\\iVMS-4200 Site\\iVMS-4200 Portal\\iVMS-4200 Lite.exe";
        
        if (PathFileExistsW(defaultPath1.c_str())) {
            appPath = defaultPath1;
            dirPath = L"C:\\Program Files (x86)\\iVMS-4200 Site\\iVMS-4200 Portal";
            dllPath = dirPath + L"\\iVMS_Popout.dll";
        } else if (PathFileExistsW(defaultPath2.c_str())) {
            appPath = defaultPath2;
            dirPath = L"C:\\Program Files\\iVMS-4200 Site\\iVMS-4200 Portal";
            dllPath = dirPath + L"\\iVMS_Popout.dll";
        } else {
            std::wcerr << L"[Error] Cannot find iVMS-4200 Lite.exe. Please copy this Launcher to the iVMS-4200 Lite installation directory." << std::endl;
            system("pause");
            return 1;
        }
    }

    std::wstring appDir = appPath.substr(0, appPath.find_last_of(L"\\/"));

    std::wcout << L"[Launcher] Target App: " << appPath << std::endl;
    std::wcout << L"[Launcher] Working Dir: " << appDir << std::endl;
    std::wcout << L"[Launcher] Patch DLL: " << dllPath << std::endl;

    // Khởi động iVMS-4200 Lite ở chế độ bình thường (không suspend) để Windows Loader nạp các DLL hệ thống trước
    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi = { 0 };

    BOOL success = CreateProcessW(
        appPath.c_str(),
        NULL,
        NULL,
        NULL,
        FALSE,
        0, // Chạy bình thường
        NULL,
        appDir.c_str(), // Thiết lập Working Directory chính xác của ứng dụng con
        &si,
        &pi
    );

    if (!success) {
        std::wcerr << L"[Error] CreateProcessW failed. Error code: " << GetLastError() << std::endl;
        system("pause");
        return 1;
    }

    std::wcout << L"[Launcher] Process created. PID: " << pi.dwProcessId << std::endl;

    // Đợi 300ms để Windows Loader nạp hoàn tất kernel32.dll trong tiến trình đích trước khi inject
    Sleep(300);

    // Tiến hành tiêm DLL vào tiến trình đang chạy
    if (!InjectDLL(pi.hProcess, dllPath)) {
        std::wcerr << L"[Error] DLL Injection failed!" << std::endl;
        TerminateProcess(pi.hProcess, 0);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        system("pause");
        return 1;
    }

    std::wcout << L"[Launcher] Patch DLL injected successfully!" << std::endl;

    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    std::wcout << L"[Launcher] Launch complete." << std::endl;
    return 0;
}
