# AE64 Max Control

Driver web chạy **cục bộ** cho bàn phím Everglide AE64 Max: chỉnh hành trình (Actuation, Rapid Trigger,
vùng chết), keymap, đèn, macro… trực tiếp qua WebHID. Không cần tài khoản, không gửi dữ liệu ra ngoài,
dùng được cả khi không có mạng sau lần mở đầu tiên.

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
   ở các thẻ bên dưới. Thay đổi được **tự động ghi vào phím** sau ~0,35 giây và được đọc lại để xác minh;
   trạng thái hiển thị ở góc trên ("Đã lưu vào phím" / "Đang ghi…" / "Lỗi — thử lại").
4. **Ctrl+Z / Ctrl+Y** để hoàn tác / làm lại trong phiên làm việc.

## An toàn

- Ứng dụng **không bao giờ** gửi lệnh cập nhật firmware (family `08`) hay khôi phục cài đặt gốc; mã
  "Factory reset" cũng không có trong bộ chọn phím.
- Chỉ ghi khi bảng mạch là `0030000D` (AE64 Max) hoặc `0030000A` (AE64 Pro); bàn phím khác được mở ở chế
  độ chỉ đọc.
- Mỗi lần ghi hành trình đều giữ nguyên các thông số trục/calibrate đọc từ phím, rồi đọc lại để so sánh.
- Nếu đang mở driver gốc (hub.xsyd.top) ở tab khác, hãy đóng nó trước khi kết nối.

## Tài liệu

- `docs/ARCHITECTURE.md` — cấu trúc thư mục, mô hình trang theo từng phím, cách thêm trang mới.
