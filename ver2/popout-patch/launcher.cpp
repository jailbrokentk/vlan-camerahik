#include <windows.h>
#include <iostream>
#include <string>
#include <tlhelp32.h>

// Hàm inject DLL vào một tiến trình Win32
bool InjectDLL(DWORD processId, const std::wstring& dllPath) {
    HANDLE hProcess = OpenProcess(PROCESS_ALL_ACCESS, FALSE, processId);
    if (!hProcess) {
        std::wcerr << L"[Launcher] Failed to open target process. Error: " << GetLastError() << std::endl;
        return false;
    }

    // Cấp phát bộ nhớ cho đường dẫn DLL bên trong không gian tiến trình đích
    size_t size = (dllPath.length() + 1) * sizeof(wchar_t);
    LPVOID pDllPath = VirtualAllocEx(hProcess, NULL, size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!pDllPath) {
        std::wcerr << L"[Launcher] Failed to allocate memory in target process. Error: " << GetLastError() << std::endl;
        CloseHandle(hProcess);
        return false;
    }

    // Ghi đường dẫn DLL vào không gian nhớ vừa cấp phát
    if (!WriteProcessMemory(hProcess, pDllPath, dllPath.c_str(), size, NULL)) {
        std::wcerr << L"[Launcher] Failed to write memory in target process. Error: " << GetLastError() << std::endl;
        VirtualFreeEx(hProcess, pDllPath, 0, MEM_RELEASE);
        CloseHandle(hProcess);
        return false;
    }

    // Lấy địa chỉ hàm LoadLibraryW trong kernel32.dll
    LPTHREAD_START_ROUTINE pLoadLibrary = (LPTHREAD_START_ROUTINE)GetProcAddress(
        GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW");
    if (!pLoadLibrary) {
        std::wcerr << L"[Launcher] Failed to get LoadLibraryW address." << std::endl;
        VirtualFreeEx(hProcess, pDllPath, 0, MEM_RELEASE);
        CloseHandle(hProcess);
        return false;
    }

    // Tạo luồng từ xa để gọi LoadLibraryW nạp DLL của chúng ta
    HANDLE hThread = CreateRemoteThread(hProcess, NULL, 0, pLoadLibrary, pDllPath, 0, NULL);
    if (!hThread) {
        std::wcerr << L"[Launcher] Failed to create remote thread. Error: " << GetLastError() << std::endl;
        VirtualFreeEx(hProcess, pDllPath, 0, MEM_RELEASE);
        CloseHandle(hProcess);
        return false;
    }

    // Chờ luồng thực thi xong
    WaitForSingleObject(hThread, INFINITE);

    CloseHandle(hThread);
    VirtualFreeEx(hProcess, pDllPath, 0, MEM_RELEASE);
    CloseHandle(hProcess);
    return true;
}

int main() {
    std::wcout << L"========================================" << std::endl;
    std::wcout << L"   iVMS-4200 Lite Popout Launcher v2.0  " << std::endl;
    std::wcout << L"========================================" << std::endl;

    // Tìm thư mục hiện tại để xác định vị trí của iVMS_Popout.dll
    wchar_t currentDir[MAX_PATH];
    GetModuleFileNameW(NULL, currentDir, MAX_PATH);
    std::wstring dirPath(currentDir);
    size_t lastSlash = dirPath.find_last_of(L"\\/");
    if (lastSlash != std::wstring::npos) {
        dirPath = dirPath.substr(0, lastSlash);
    }
    std::wstring dllPath = dirPath + L"\\iVMS_Popout.dll";

    // Đường dẫn mặc định của iVMS-4200 Lite
    // Nếu Launcher được đặt cùng thư mục cài đặt iVMS-4200 Lite, ta dùng exe cùng thư mục.
    // Ngược lại, thử tìm trong thư mục cài đặt mặc định Program Files.
    std::wstring targetExe = L"iVMS-4200 Lite.exe";
    std::wstring appPath = dirPath + L"\\" + targetExe;

    DWORD fileAttr = GetFileAttributesW(appPath.c_str());
    if (fileAttr == INVALID_FILE_ATTRIBUTES) {
        // Thử tìm trong Program Files (x86) và Program Files
        std::wstring programFilesX86 = L"C:\\Program Files (x86)\\iVMS-4200 Site\\iVMS-4200 Portal\\iVMS-4200 Lite.exe";
        std::wstring programFilesStandard = L"C:\\Program Files\\iVMS-4200 Site\\iVMS-4200 Portal\\iVMS-4200 Lite.exe";
        
        if (GetFileAttributesW(programFilesX86.c_str()) != INVALID_FILE_ATTRIBUTES) {
            appPath = programFilesX86;
        } else if (GetFileAttributesW(programFilesStandard.c_str()) != INVALID_FILE_ATTRIBUTES) {
            appPath = programFilesStandard;
        } else {
            std::wcerr << L"[Error] Cannot find iVMS-4200 Lite.exe. Please copy this Launcher to the iVMS-4200 Lite installation directory." << std::endl;
            system("pause");
            return 1;
        }
    }

    std::wcout << L"[Launcher] Target App: " << appPath << std::endl;
    std::wcout << L"[Launcher] Patch DLL: " << dllPath << std::endl;

    // Khởi động iVMS-4200 Lite ở chế độ SUSPENDED (treo) để inject DLL trước khi nó chạy code chính
    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi = { 0 };

    BOOL success = CreateProcessW(
        appPath.c_str(),
        NULL,
        NULL,
        NULL,
        FALSE,
        CREATE_SUSPENDED,
        NULL,
        NULL,
        &si,
        &pi
    );

    if (!success) {
        std::wcerr << L"[Error] Failed to start iVMS-4200 Lite. Error: " << GetLastError() << std::endl;
        system("pause");
        return 1;
    }

    std::wcout << L"[Launcher] Process created suspended. PID: " << pi.dwProcessId << std::endl;

    // Inject DLL vào tiến trình vừa tạo
    if (InjectDLL(pi.dwProcessId, dllPath)) {
        std::wcout << L"[Launcher] Patch DLL injected successfully!" << std::endl;
    } else {
        std::wcerr << L"[Warning] DLL Injection failed. iVMS Lite will start without Popout Panel." << std::endl;
    }

    // Đánh thức tiến trình để bắt đầu chạy
    ResumeThread(pi.hThread);

    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);

    std::wcout << L"[Launcher] Launch complete." << std::endl;
    return 0;
}
