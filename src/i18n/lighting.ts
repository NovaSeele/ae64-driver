// Strings for the lighting area (Vietnamese UI, English technical terms). Keys are prefixed 'lighting.'.
export const lightingVi = {
  // Navigation & tabs
  'lighting.tabKeys': 'Bàn phím',
  'lighting.tabStrip': 'Dải đèn viền',
  'lighting.tabKeysSub': 'LED trên và dưới mỗi phím',
  'lighting.tabStripSub': '38 LED quanh viền bàn phím',
  'lighting.tabsLabel': 'Chọn vùng điều khiển đèn',
  'lighting.ringLabel': 'Dải đèn viền, 38 LED',
  'lighting.ledLabel': 'LED {n}, {side}',
  'lighting.sideTop': 'cạnh trên',
  'lighting.sideRight': 'cạnh phải',
  'lighting.sideBottom': 'cạnh dưới',
  'lighting.sideLeft': 'cạnh trái',

  // Live preview
  'lighting.livePreview': 'Xem trước trực tiếp',
  'lighting.livePreviewHint': 'Đọc liên tục từ bàn phím (~10 Hz)',
  'lighting.liveStatus': 'Trực tiếp',
  'lighting.simStatus': 'Mô phỏng',
  'lighting.pausedStatus': 'Tạm dừng',
  'lighting.liveError': 'Lỗi đọc',

  // Power / Open mode
  'lighting.powerTitle': 'Chế độ bật đèn',
  'lighting.modeOff': 'Tắt',
  'lighting.modeBottom': 'Phía dưới',
  'lighting.modeTop': 'Phía trên',
  'lighting.modeBoth': 'Cả hai',
  'lighting.modeOn': 'Bật',
  'lighting.readOnly': 'Bảng mạch không nằm trong danh sách được phép ghi — chỉ xem, không thể chỉnh đèn.',
  'lighting.powerHintKeys': 'Mỗi phím có LED phía dưới và phía trên; chọn phía nào sáng.',
  'lighting.powerHintStrip': 'Bật hoặc tắt dải đèn viền.',
  'lighting.powerOffHint': 'Đèn đang tắt. Bật lại ở "Chế độ bật đèn" để chỉnh hiệu ứng, độ sáng và màu.',

  // Effects
  'lighting.effectsTitle': 'Hiệu ứng ánh sáng',
  'lighting.effectsShort': 'Hiệu ứng',
  'lighting.effectsDesc': 'Chọn kiểu chiếu sáng cho vùng đang chọn.',
  'lighting.demoSimNote': 'Demo: khung xem trước chỉ mô phỏng chuyển động để bạn thấy hiệu ứng, độ sáng, tốc độ, hướng và màu thay đổi thế nào. Trên bàn phím thật, khung này đọc đèn trực tiếp từ phím nên hiệu ứng có thể trông khác.',
  'lighting.effectN': 'Hiệu ứng {n}',
  'lighting.experimentalEffect': 'Thử nghiệm',

  // Tuning (Brightness, Speed, Direction)
  'lighting.tuningTitle': 'Điều chỉnh hiệu ứng',
  'lighting.tuningShort': 'Điều chỉnh',
  'lighting.tuningDesc': 'Tuỳ chỉnh độ sáng, tốc độ và chiều chuyển động.',
  'lighting.brightness': 'Độ sáng',
  'lighting.speed': 'Tốc độ',
  'lighting.direction': 'Hướng chuyển động',
  'lighting.directionShort': 'Hướng',
  'lighting.directionForward': 'Tiến',
  'lighting.directionBackward': 'Lùi',

  // Palette
  'lighting.paletteTitle': 'Bảng màu',
  'lighting.paletteDesc': '8 màu firmware. Ô 0 là Cầu vồng; các ô 1–7 có thể chỉnh màu tuỳ ý.',
  'lighting.rainbow': 'Cầu vồng',
  'lighting.rainbowSlot': 'RGB Cầu vồng',
  'lighting.paletteSlot': 'Màu {n}',
  'lighting.rainbowHint': 'Chế độ cầu vồng được firmware tính toán tự động qua dải phổ.',
  'lighting.editColorBtn': 'Sửa màu…',
  'lighting.editColorTitle': 'Sửa màu {n} · Bảng màu {area}',
  'lighting.rainbowNoEdit': 'Ô Cầu vồng do firmware tính, không có màu để sửa.',
  'lighting.activeSlot': 'Đang chọn: {name}',

  // Per-key custom colors
  'lighting.perKeyTitle': 'Màu riêng từng phím',
  'lighting.perKeyDesc': 'Chọn phím trên bàn phím để gán màu tĩnh ghi đè lên hiệu ứng nền.',
  'lighting.selectedKeyOne': 'Đã chọn 1 phím',
  'lighting.selectedKeys': 'Đã chọn {count} phím',
  'lighting.pickColor': 'Chọn màu',
  'lighting.applyKeysN': 'Áp dụng cho {count} phím',
  'lighting.applyLedsN': 'Áp dụng cho {count} LED',
  'lighting.applyColor': 'Áp dụng màu',
  'lighting.clearShort': 'Xoá màu',
  'lighting.clearAllN': 'Xoá tất cả màu riêng ({count})…',
  'lighting.customMetaKeys': '{count} phím đang dùng màu riêng',
  'lighting.customMetaLeds': '{count} LED đang dùng màu riêng',
  'lighting.clearKeyColor': 'Xoá màu phím đã chọn',
  'lighting.clearAllKeyColors': 'Xoá tất cả màu riêng',
  'lighting.confirmClearKeysTitle': 'Xoá tất cả màu riêng của phím?',
  'lighting.confirmClearKeysBody': 'Mọi phím sẽ quay lại theo hiệu ứng nền. Có thể hoàn tác bằng Ctrl+Z.',
  'lighting.spaceNote': 'Phím Space chiếm 5 bóng LED trên mạch; màu được áp dụng đồng bộ cho cả 5 bóng.',

  // Strip custom colors
  'lighting.stripHint': 'Click một LED trên viền để chọn hoặc bỏ chọn',
  'lighting.stripCustomTitle': 'Màu riêng từng LED viền',
  'lighting.stripCustomDesc': 'Gán màu tĩnh riêng cho từng bóng LED trên dải viền 38 bóng.',
  'lighting.selectedLedNone': 'Chưa chọn LED',
  'lighting.selectedLedOne': 'Đã chọn 1 LED',
  'lighting.selectedLeds': 'Đã chọn {count} LED',
  'lighting.selectTop': 'Cạnh trên',
  'lighting.selectBottom': 'Cạnh dưới',
  'lighting.selectLeft': 'Cạnh trái',
  'lighting.selectRight': 'Cạnh phải',
  'lighting.clearStripColor': 'Xoá màu LED đã chọn',
  'lighting.clearAllStripColors': 'Xoá tất cả màu LED',
  'lighting.confirmClearStripTitle': 'Xoá tất cả màu riêng của LED viền?',
  'lighting.confirmClearStripBody': 'Mọi LED trên dải viền sẽ quay lại theo hiệu ứng nền. Có thể hoàn tác bằng Ctrl+Z.',

  // Loading & status
  'lighting.loading': 'Đang đọc cấu hình đèn…',
  'lighting.loadFailed': 'Không thể đọc cấu hình đèn',
  'lighting.reload': 'Đọc lại',

  // Sync labels for history / status
  'lighting.syncBase': 'Đổi cài đặt đèn ({area})',
  'lighting.syncPalette': 'Đổi bảng màu ({area})',
  'lighting.syncMatrix': 'Đổi màu riêng ({area})',
} as const;
