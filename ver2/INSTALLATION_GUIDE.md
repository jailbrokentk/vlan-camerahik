# Hướng Dẫn Cài Đặt Mới Toàn Bộ vLAN-CameraHIK

Dự án này là phần mềm giám sát và xem lại camera chuyên nghiệp dành cho thiết bị Hikvision, được xây dựng trên nền tảng **React + Electron** kết hợp module native C++ giao tiếp trực tiếp với **Hikvision HCNetSDK**.

---

## 🚀 1. Dành Cho Người Dùng Cuối (Cài Đặt Nhanh)

Nếu bạn chỉ cần cài đặt và sử dụng ứng dụng mà không cần quan tâm đến mã nguồn:

1. **Tải bộ cài đặt:**
   * Tìm và lấy tệp tin cài đặt Setup tại đường dẫn: `dist/vLAN-CameraHIK Setup 1.0.0.exe` (được sinh ra sau khi build thành công).
2. **Cài đặt:**
   * Nhấp đúp chuột vào tệp `vLAN-CameraHIK Setup 1.0.0.exe`.
   * Trình cài đặt sẽ tự động thiết lập phần mềm và tạo biểu tượng Shortcut ngoài màn hình chính (Desktop) của bạn.
3. **Khởi động và sử dụng:**
   * Mở ứng dụng lên.
   * **Đăng ký tài khoản cục bộ:** Vì lý do bảo mật thông tin tài khoản Camera của bạn, ứng dụng yêu cầu bạn thiết lập một tài khoản quản trị cục bộ (chỉ lưu trên máy tính của bạn).
   * **Đăng nhập:** Đăng nhập bằng tài khoản vừa tạo.
   * **Thêm thiết bị (NVR/Camera):** Vào mục **Cài đặt** (Settings) hoặc chọn **Thêm thiết bị** (Add Device), điền các thông tin:
     * Địa chỉ IP thiết bị (Ví dụ: `172.16.0.30`)
     * HTTP Port (Mặc định: `80`)
     * SDK Port (Mặc định: `8000`)
     * Tài khoản & Mật khẩu của camera/đầu ghi Hikvision.
   * Sau khi thêm thành công, danh sách camera sẽ xuất hiện ở Sidebar bên trái. Bạn có thể kéo thả camera vào lưới LiveView để xem trực tiếp hoặc chuyển sang tab Playback để xem lại.

---

## 🛠️ 2. Dành Cho Nhà Phát Triển (Cài Đặt Môi Trường & Biên Dịch)

Để chạy dự án ở chế độ phát triển (Development) hoặc tự build lại file cài đặt từ mã nguồn:

### Yêu Cầu Hệ Thống (Prerequisites):
1. **Hệ điều hành:** Windows 10 hoặc Windows 11 (bắt buộc vì SDK Hikvision là dạng Win32 dll).
2. **Node.js:** Phiên bản Node LTS (Khuyến nghị **v20.x** hoặc **v22.x**).
3. **Công cụ biên dịch C++:**
   * Đã cài đặt **Visual Studio C++ Build Tools** (hoặc Visual Studio phiên bản từ 2019 trở lên có tích hợp C++ Desktop Development).
   * Đã cài đặt **Python 3.x** (phục vụ tiến trình chạy `node-gyp` biên dịch).

---

### Các Bước Thực Hiện:

#### Bước 1: Tải mã nguồn từ GitHub
Mở Windows PowerShell hoặc CMD và chạy các lệnh:
```bash
# Clone mã nguồn
git clone https://github.com/jailbrokentk/vlan-camerahik.git

# Di chuyển vào thư mục dự án
cd vlan-camerahik

# Checkout sang nhánh làm việc mới nhất
git checkout fix/package-hcnet-native-addon
```

#### Bước 2: Cài đặt Node dependencies
Chạy lệnh cài đặt các thư viện Node:
```bash
npm install
```

#### Bước 3: Biên dịch native C++ addon (`hcnet-addon`)
Dự án sử dụng module C++ giao tiếp với SDK Hikvision nằm trong thư mục `hcnet-addon/`. Cần compile module này tương ứng với phiên bản Electron đang sử dụng (`v33.4.11`):
```bash
npm run native:rebuild
```
*Lệnh này sẽ tự động dọn dẹp thư mục build cũ, chạy `cmake-js` cấu hình và biên dịch mã nguồn C++ thành tệp native `hcnet-addon.node` đặt tại `hcnet-addon/build/Release/`.*

#### Bước 4: Khởi chạy dự án ở chế độ phát triển (Development)
Để bắt đầu lập trình và kiểm thử trực tiếp:
```bash
npm run dev:electron
```
*Lệnh này sẽ khởi chạy Vite Dev Server cho React Frontend và đồng thời khởi động cửa sổ Electron liên kết với IPC backend dưới cục bộ.*

---

## 📦 3. Đóng Gói Và Tạo Bộ Cài Đặt (Production Build)

Khi muốn đóng gói toàn bộ mã nguồn thành tệp Setup cài đặt `.exe` duy nhất:

```bash
# Bước 1: Biên dịch mã nguồn React Frontend
npm run build:renderer

# Bước 2: Đóng gói gói cài đặt EXE bằng electron-builder
npx electron-builder --win --x64
```
Hoặc bạn có thể chạy một lệnh tích hợp sẵn (tự động chạy rebuild addon, build frontend và đóng gói):
```bash
npm run dist:win
```

Sau khi chạy xong, bộ cài đặt mới sẽ được xuất ra tại thư mục:
`dist/vLAN-CameraHIK Setup 1.0.0.exe`

---

## 🗂️ Cấu Trúc Các Thư Mục Quan Trọng
* `electron/`: Chứa mã nguồn IPC Backend điều phối luồng (Main process).
  * `electron/main.js`: File chạy chính của Electron, quản lý vòng đời ứng dụng và IPC.
  * `electron/services/hcnetService.js`: Service trung gian gọi các hàm C++ native.
* `hcnet-addon/`: Module C++ native liên kết SDK Hikvision (`addon.cpp`).
* `src/`: Mã nguồn React Frontend (Renderer process).
  * `src/components/`: Các React components (CameraCell, PlaybackView, Timeline...).
  * `src/pages/`: Các trang chính (LiveView, Playback, Settings).
  * `src/i18n/`: Các file đa ngôn ngữ tiếng Anh (`en.js`) và tiếng Việt (`vi.js`).
* `resources/sdk/`: Chứa các tệp SDK Hikvision gốc (`HCNetSDK.dll`, `PlayCtrl.dll`, các thư mục con...) để tự động đính kèm vào phần mềm khi đóng gói.
