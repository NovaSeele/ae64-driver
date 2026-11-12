# AE64 Control

[English](README.md) · **Tiếng Việt**

Driver cục bộ cho dòng phím Everglide AE64: chỉnh hành trình (Actuation, Rapid Trigger, Deadzone),
keymap, đèn, macro… trực tiếp qua WebHID.

Bàn phím được hỗ trợ: **AE64 Max** (board `0030000D`, USB PID `0x300D`) và **AE64 Pro** (board `0030000A`, USB PID `0x300A`).

**Tải về cho Windows:** [bản phát hành mới nhất](https://github.com/NovaSeele/ae64-driver/releases/latest):
`AE64-Control_<version>_x64-setup.exe` (bộ cài) hoặc `AE64-Control_<version>_x64-portable.zip` (chỉ có file exe).
Xem [Ứng dụng desktop](#ứng-dụng-desktop-windows) về SmartScreen, WebView2 và nơi ứng dụng lưu dữ liệu.

## Dùng trực tuyến

Mở **<https://ae64.novaseele.com>** bằng Chrome hoặc Edge, cắm bàn phím rồi bấm **Kết nối bàn phím**.
Không cần cài đặt gì.

- Trình duyệt **Google Chrome hoặc Microsoft Edge bản desktop** (WebHID chỉ có trên các trình duyệt này).
  Firefox và Safari không hỗ trợ.
- Bàn phím Everglide AE64 Max hoặc AE64 Pro cắm bằng cáp USB.
- Quyền WebHID tính theo từng trang: sau khi chuyển từ ae64max.novaseele.com sang ae64.novaseele.com, bạn chọn lại bàn phím một lần trong hộp thoại của trình duyệt.

## Chạy cục bộ (không bắt buộc)

Chỉ cần khi bạn muốn tự chạy một bản riêng thay vì dùng link ở trên. Cần **Node.js 22** (đã thử với 22.23)
trên Windows, macOS hoặc Linux.

Bấm đúp **`start.cmd`** ở thư mục gốc. Lần đầu nó sẽ cài thư viện và build; sau đó chỉ chạy máy chủ xem
trước tại <http://127.0.0.1:4173> và tự mở trình duyệt. Đóng cửa sổ dòng lệnh để tắt.

### Dành cho phát triển

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # kiểm tra kiểu + build vào dist/
npm run preview    # http://127.0.0.1:4173
npm test           # vitest
npm run typecheck
```

## Sử dụng

1. Bấm **Kết nối bàn phím** và chọn bàn phím AE64 của bạn trong hộp thoại của trình duyệt. Lần sau ứng dụng tự kết
   nối lại với bàn phím đã cấp quyền.
2. Không có bàn phím? Bấm **Chế độ demo** để dùng thử với bàn phím giả lập.
3. Chọn phím trên hình bàn phím (Ctrl/Shift để chọn thêm, kéo chuột để quét vùng, Esc để bỏ chọn) rồi chỉnh
   ở các thẻ bên dưới. Thay đổi được **tự động ghi vào phím** sau ~0,35 giây; trạng thái
   hiển thị ở góc trên ("Đã lưu vào phím" / "Đang ghi…" / "Lỗi — thử lại").
4. **Ctrl+Z / Ctrl+Y** để hoàn tác / làm lại trong phiên làm việc.

## Ứng dụng desktop (Windows)

Một vỏ [Tauri 2](https://tauri.app) nhỏ bọc đúng trang web này, dùng WebView2 của hệ thống. Trang tự nói chuyện
với bàn phím qua WebHID; vỏ không thêm mã thiết bị nào.

- Tải ở [Releases](https://github.com/NovaSeele/ae64-driver/releases/latest): bộ cài
  `AE64-Control_<version>_x64-setup.exe` hoặc bản portable `AE64-Control_<version>_x64-portable.zip`.
- Bộ cài chỉ cài cho người dùng hiện tại, không cần quyền quản trị. Nếu máy thiếu WebView2, bộ cài tự tải và cài
  (Windows 10/11 thường đã có sẵn).
- Bản portable chỉ là file exe: vẫn cần WebView2 runtime (Windows 10/11 thường đã có sẵn).
- Ứng dụng chưa ký số nên SmartScreen có thể báo "Windows protected your PC": bấm "More info" (Thông tin thêm)
  rồi "Run anyway" (Vẫn chạy).
- Ứng dụng desktop không bao giờ tự cập nhật. Muốn cập nhật, cài bản `setup.exe` mới hơn.
- Cả bản cài lẫn bản portable đều lưu dữ liệu (cài đặt, quyền WebHID) trong `%LOCALAPPDATA%\com.novaseele.ae64`.
  Gỡ cài đặt giữ thư mục này, trừ khi bạn tick "Delete the application data" trong trình gỡ; nếu không, xoá bằng
  tay khi muốn sạch hẳn.
- Tự build: `npm run desktop:build` (cần Rust và WebView2); chi tiết ở [bản tiếng Anh](README.md#desktop-app-windows).

## Cập nhật ứng dụng

Khác với driver của nhà sản xuất vốn tự động tải phiên bản mới trong nền, AE64 Control **không bao giờ tự động cập nhật**. Ứng dụng tiếp tục chạy phiên bản đang có cho tới khi người dùng chủ động bấm kiểm tra và cập nhật.

- Service worker (`sw.js`) là tệp tĩnh không đổi giữa các bản build, tránh việc trình duyệt tự động nạp phiên bản mới.
- Quá trình build sinh ra `release.json` (chứa mã phiên bản, ngày giờ build và danh sách tệp của bản phát hành).
- Khi người dùng mở hộp thoại Trợ giúp và bấm **Kiểm tra cập nhật**, ứng dụng so sánh phiên bản hiện tại với `release.json`.
- Khi bấm **Cập nhật**, service worker tải toàn bộ các tệp của bản mới vào cache mới (theo cơ chế all-or-nothing), chuyển phiên bản và tải lại trang.
- Máy chủ web (nginx) cấu hình `/assets/` là immutable, còn `index.html`, `sw.js` và `release.json` đặt `no-cache` / `no-store`.

## An toàn

- Ứng dụng **không bao giờ** gửi lệnh cập nhật firmware (family `08`) hay khôi phục cài đặt gốc; mã
  "Factory reset" cũng không có trong bộ chọn phím.
- Chỉ ghi khi bảng mạch là `0030000D` (AE64 Max) hoặc `0030000A` (AE64 Pro); bàn phím khác được mở ở chế
  độ chỉ đọc.
- Mỗi lần ghi hành trình đều giữ nguyên các thông số trục/calibrate đọc từ phím, rồi đọc lại để so sánh.
- Lớp bảo vệ cuối cùng nằm trong transport (`src/protocol/safety.ts`): mọi gói tin phải nằm trong danh sách
  lệnh được phép, kèm kiểm tra phạm vi đối số (profile, layer, hàng/cột, nhóm lưu…). Gói không khớp bị chặn
  trước khi tới bàn phím, bất kể trang nào tạo ra nó.
- Ghi hành trình bị từ chối nếu chưa đọc phím đó trước, nếu làm thay đổi trường cảm biến (`axis`,
  `calibrate`), nếu đổi các trường switch (`axisV2Id`, `axisRangeMax`, `axisCoefficient`) sang giá trị khác
  giá trị phím đã báo hoặc một mục nguyên vẹn trong danh sách switch của bảng mạch, hoặc nếu khoảng cách vượt
  hành trình của switch.
- Chế độ hành trình: `0` Standard, `1` Rapid Trigger liên tục (Continuous RT), `2` Rapid Trigger không liên
  tục (IntervalRT của driver gốc). Ứng dụng đọc nguyên giá trị từ phím và giữ nguyên khi ghi lại; chế độ `2`
  chỉ được ghi khi phím báo protocol ≥ 1.3.0.0 (đúng điều kiện của driver gốc) hoặc phím đó vốn đang ở chế độ `2`.
- Các keycode nguy hiểm (Factory reset F200, chuyển chế độ không dây, xoá ghép nối) không bao giờ được ghi —
  kể cả khi nhập từ file sao lưu hay khôi phục layer mặc định.
- Cài đặt chung (OS, tắt đèn, chống rung) ghi trực tiếp như driver gốc, không commit. Đổi polling rate luôn là
  lệnh cuối cùng của phiên (bàn phím khởi động lại cổng USB), sau đó ứng dụng tự kết nối lại; polling rate
  không được khôi phục từ file sao lưu.
- Nếu calibrate bị gián đoạn, ứng dụng vẫn gửi lệnh dừng calibrate (không lưu).
- Nếu đang mở driver gốc (hub.xsyd.top) ở tab khác, hãy đóng nó trước khi kết nối.

## Tài liệu

- `docs/ARCHITECTURE.md` — cấu trúc thư mục, mô hình trang theo từng phím, cách thêm trang mới.
