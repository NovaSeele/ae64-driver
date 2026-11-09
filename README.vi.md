# AE64 Max Control

[English](README.md) · **Tiếng Việt**

Driver web remake cho bàn phím Everglide AE64 Max: chỉnh hành trình (Actuation, Rapid Trigger, vùng chết),
keymap, đèn, macro… trực tiếp qua WebHID.

## Yêu cầu

- Windows (hoặc macOS/Linux) có **Node.js 22** (đã thử với 22.23).
- Trình duyệt **Google Chrome hoặc Microsoft Edge bản desktop** (WebHID chỉ có trên các trình duyệt này).
  Firefox và Safari không hỗ trợ.
- Bàn phím Everglide AE64 Max cắm bằng cáp USB.

## Chạy hằng ngày

Bấm đúp **`start.cmd`** ở thư mục gốc. Lần đầu nó sẽ cài thư viện và build; sau đó chỉ chạy máy chủ xem
trước tại <http://127.0.0.1:4173> và tự mở trình duyệt. Đóng cửa sổ dòng lệnh để tắt.

## Dành cho phát triển

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # kiểm tra kiểu + build vào dist/
npm run preview    # http://127.0.0.1:4173
npm test           # vitest
npm run typecheck
```

## Sử dụng

1. Bấm **Kết nối bàn phím** và chọn `AE64-MAX` trong hộp thoại của trình duyệt. Lần sau ứng dụng tự kết
   nối lại với bàn phím đã cấp quyền.
2. Không có bàn phím? Bấm **Chế độ demo** để dùng thử với bàn phím giả lập.
3. Chọn phím trên hình bàn phím (Ctrl/Shift để chọn thêm, kéo chuột để quét vùng, Esc để bỏ chọn) rồi chỉnh
   ở các thẻ bên dưới. Thay đổi được **tự động ghi vào phím** sau ~0,35 giây; trạng thái
   hiển thị ở góc trên ("Đã lưu vào phím" / "Đang ghi…" / "Lỗi — thử lại").
4. **Ctrl+Z / Ctrl+Y** để hoàn tác / làm lại trong phiên làm việc.

## Cập nhật ứng dụng

Khác với driver của nhà sản xuất vốn tự động tải phiên bản mới trong nền, AE64 Max Control **không bao giờ tự động cập nhật**. Ứng dụng tiếp tục chạy phiên bản đang có cho tới khi người dùng chủ động bấm kiểm tra và cập nhật.

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
