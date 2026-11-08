// Strings for the lighting area (Vietnamese UI, English technical terms). Keys are prefixed 'lighting.'.
export const lightingVi = {
  // Navigation & tabs
  'lighting.tabKeys': 'Bàn phím',
  'lighting.tabStrip': 'Dải đèn LED',
  'lighting.tabsLabel': 'Chọn vùng điều khiển đèn',

  // Live preview
  'lighting.livePreview': 'Xem trước trực tiếp',
  'lighting.livePreviewHint': 'Đọc liên tục từ bàn phím (~10 Hz)',
  'lighting.liveStatus': 'Trực tiếp',
  'lighting.pausedStatus': 'Tạm dừng',

  // Power / Open mode
  'lighting.powerTitle': 'Chế độ bật đèn',
  'lighting.powerKeysDesc': 'Điều khiển bóng LED phía trên / dưới của switch',
  'lighting.powerStripDesc': 'Bật hoặc tắt dải đèn viền 38 LED',
  'lighting.modeOff': 'Tắt',
  'lighting.modeBottom': 'Phía dưới',
  'lighting.modeTop': 'Phía trên',
  'lighting.modeBoth': 'Cả hai',
  'lighting.modeOn': 'Bật',

  // Effects
  'lighting.effectsTitle': 'Hiệu ứng ánh sáng',
  'lighting.effectsDesc': 'Chọn kiểu chiếu sáng cho vùng đang chọn.',
  'lighting.effectN': 'Hiệu ứng {n}',
  'lighting.experimentalEffect': 'Thử nghiệm',

  // Tuning (Brightness, Speed, Direction)
  'lighting.tuningTitle': 'Điều chỉnh hiệu ứng',
  'lighting.tuningDesc': 'Tuỳ chỉnh độ sáng, tốc độ và chiều chuyển động.',
  'lighting.brightness': 'Độ sáng',
  'lighting.speed': 'Tốc độ',
  'lighting.direction': 'Hướng chuyển động',
  'lighting.directionForward': 'Tiến',
  'lighting.directionBackward': 'Lùi',

  // Palette
  'lighting.paletteTitle': 'Bảng màu',
  'lighting.paletteDesc': '8 màu firmware. Ô 0 là Cầu vồng; các ô 1–7 có thể chỉnh màu tuỳ ý.',
  'lighting.rainbow': 'Cầu vồng',
  'lighting.rainbowSlot': 'RGB Cầu vồng',
  'lighting.paletteSlot': 'Màu {n}',
  'lighting.rainbowHint': 'Chế độ cầu vồng được firmware tính toán tự động qua dải phổ.',
  'lighting.editColor': 'Chỉnh sửa màu {n}',
  'lighting.activeSlot': 'Đang chọn: {name}',

  // Per-key custom colors
  'lighting.perKeyTitle': 'Màu riêng từng phím',
  'lighting.perKeyDesc': 'Chọn phím trên bàn phím để gán màu tĩnh ghi đè lên hiệu ứng nền.',
  'lighting.selectedKeys': 'Đã chọn {count} phím',
  'lighting.noKeysSelected': 'Chưa chọn phím nào. Nhấp hoặc kéo chọn trên bàn phím phía trên.',
  'lighting.applyKeyColor': 'Áp dụng màu cho phím',
  'lighting.clearKeyColor': 'Xoá màu phím đã chọn',
  'lighting.clearAllKeyColors': 'Xoá tất cả màu riêng',
  'lighting.customActive': 'Đang có {count} phím dùng màu riêng',
  'lighting.spaceNote': 'Phím Space chiếm 5 bóng LED trên mạch; màu được áp dụng đồng bộ cho cả 5 bóng.',

  // Strip custom colors
  'lighting.stripTitle': 'Dải đèn viền (38 LED)',
  'lighting.stripSubtitle': 'Nhấp vào bóng LED trên thanh để chọn',
  'lighting.stripCustomTitle': 'Màu riêng từng LED viền',
  'lighting.stripCustomDesc': 'Gán màu tĩnh riêng cho từng bóng LED trên dải viền 38 bóng.',
  'lighting.selectedLeds': 'Đã chọn {count} LED',
  'lighting.noLedsSelected': 'Chưa chọn LED nào. Nhấp vào bóng trên dải đèn để chọn.',
  'lighting.selectAll': 'Tất cả',
  'lighting.selectNone': 'Bỏ chọn',
  'lighting.selectTop': 'Cạnh trên',
  'lighting.selectBottom': 'Cạnh dưới',
  'lighting.selectLeft': 'Cạnh trái',
  'lighting.selectRight': 'Cạnh phải',
  'lighting.applyStripColor': 'Áp dụng màu cho LED',
  'lighting.clearStripColor': 'Xoá màu LED đã chọn',
  'lighting.clearAllStripColors': 'Xoá tất cả màu LED',
  'lighting.stripCustomActive': 'Đang có {count} LED dùng màu riêng',

  // Loading & status
  'lighting.loading': 'Đang đọc cấu hình đèn…',
  'lighting.loadFailed': 'Không thể đọc cấu hình đèn',
  'lighting.reload': 'Đọc lại',

  // Sync labels for history / status
  'lighting.syncBase': 'Đổi cài đặt đèn {area}',
  'lighting.syncPalette': 'Đổi bảng màu {area}',
  'lighting.syncMatrix': 'Đổi màu LED {area}',
} as const;
