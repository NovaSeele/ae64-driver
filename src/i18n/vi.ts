// All UI strings (Vietnamese, technical terms kept in English). Access through t().
// Page areas keep their strings in their own file (./keymap.ts, ./live.ts, …), merged below.
import { keymapVi } from './keymap';
import { settingsVi } from './settings';
import { diagnosticsVi } from './diagnostics';
import { advancedVi } from './advanced';
import { macroVi } from './macro';
import { lightingVi } from './lighting';
import { liveVi } from './live';
import { calibrationVi } from './calibration';
import { performanceVi } from './performance';
import { applyPlurals, locale } from './locale';
import { en } from './en';

export const base = {
  'app.name': 'AE64 Max Control',
  'app.tagline': 'Driver cục bộ cho Everglide AE64 Max',

  // navigation
  'nav.configure': 'Cấu hình',
  'nav.live': 'Đo hành trình',
  'nav.update': 'Cập nhật & phiên bản',
  'nav.updateAvailableSuffix': ', có bản mới',
  'nav.collapse': 'Thu gọn thanh bên',
  'nav.expand': 'Mở thanh bên',
  'nav.groupProfile': 'Cài đặt theo profile',
  'nav.groupDevice': 'Thiết bị',
  'page.keymap': 'Keymap',
  'page.performance': 'Hành trình',
  'page.advanced': 'Phím nâng cao',
  'page.lighting': 'Đèn',
  'page.macro': 'Macro',
  'page.live': 'Đo hành trình',
  'page.calibration': 'Hiệu chuẩn',
  'page.settings': 'Cài đặt thiết bị',
  'page.diagnostics': 'Chẩn đoán',
  'page.wip': 'Đang phát triển',
  'page.wipBody': 'Trang này sẽ có trong bản cập nhật tới. Các trang khác vẫn dùng bình thường.',

  // device card / connect
  'device.disconnected': 'Chưa kết nối',
  'device.connecting': 'Đang kết nối…',
  'device.connected': 'Đã kết nối',
  'device.demo': 'Demo',
  'device.firmware': 'Firmware',
  'device.board': 'Bo mạch',
  'device.latency': 'Độ trễ',
  'device.disconnect': 'Ngắt kết nối',
  'device.notAllowed': 'Bảng mạch {board} không nằm trong danh sách được phép ghi — chế độ chỉ đọc.',
  'device.lost': 'Mất kết nối với bàn phím.',
  'device.unsavedLost': 'Mất kết nối: {n} thay đổi chưa lưu vào phím.',
  'device.calibrating': 'Bàn phím đang hiệu chuẩn: hãy kết thúc hiệu chuẩn trước.',
  'device.profile': 'Profile',
  'device.rename': 'Đổi tên profile',
  'device.renamed': 'Đã đổi tên profile thành “{name}”.',
  'device.switched': 'Đã chuyển sang {name}.',
  'connect.title': 'Kết nối bàn phím',
  'connect.subtitle': 'Cắm AE64 Max bằng cáp USB rồi bấm kết nối. Mọi thứ chạy trên máy bạn — không tài khoản, không gửi dữ liệu.',
  'connect.button': 'Kết nối bàn phím',
  'connect.demo': 'Chế độ demo',
  'connect.demoHint': 'Dùng thử với bàn phím giả lập, không cần thiết bị.',
  'connect.noHid': 'Trình duyệt này không hỗ trợ WebHID. Hãy mở bằng Chrome hoặc Edge bản desktop (qua http://127.0.0.1).',
  'connect.reconnecting': 'Đang tự kết nối lại…',
  'connect.safety': 'An toàn: ứng dụng không bao giờ cập nhật firmware hay khôi phục cài đặt gốc.',
  'connect.failed': 'Kết nối thất bại',

  // sync / history
  'sync.saved': 'Đã lưu vào phím',
  'sync.writing': 'Đang ghi…',
  'sync.error': 'Lỗi — thử lại',
  'sync.retry': 'Thử lại',
  'sync.lastProblem': 'Lần lưu trước: {msg}',
  'sync.verifyFailed': 'Đọc lại không khớp: {labels}',
  'sync.failed': 'Chưa lưu được: {labels}',
  'sync.verifyMismatch': 'đọc lại không khớp',
  'sync.otherProfile': 'thuộc profile khác, đã bỏ',
  'sync.held': 'Đang khôi phục bản sao lưu: thay đổi sẽ được ghi sau khi xong.',
  'sync.lost': 'mất kết nối trước khi lưu',
  'sync.dropped': 'Chưa lưu được: {labels}.',
  'sync.restored': 'Đã trả về giá trị đang có trên phím.',
  'history.undo': 'Hoàn tác',
  'history.redo': 'Làm lại',
  'history.disabledCalibrating': 'Không thể hoàn tác / làm lại khi bàn phím đang hiệu chuẩn.',
  'history.disabledDraft': 'Hãy hoàn tất hoặc huỷ bản nháp đang chỉnh trước.',
  'error.notConnected': 'Bàn phím chưa được kết nối.',

  // selection / keyboard
  'sel.count': '{n} phím đã chọn',
  'sel.none': 'Chưa chọn phím',
  'sel.wasd': 'WASD',
  'sel.all': 'Tất cả',
  'sel.clear': 'Bỏ chọn',
  'sel.invert': 'Đảo chọn',
  'sel.hint': 'Click để chọn · Ctrl/Shift để chọn thêm · kéo để quét vùng · Esc bỏ chọn',
  'keyboard.label': 'Bàn phím AE64 Max',

  // performance
  'perf.metric': 'Hiển thị',
  'perf.rtBadgeHint': 'Phím có nhãn RT đang bật Rapid Trigger. Xem độ nhạy nhấn/nhả ở mục Rapid Trigger, hoặc rê chuột lên phím.',
  'perf.rtViewHint': '↓ độ nhạy nhấn · ↑ độ nhạy nhả (mm). Phím không bật Rapid Trigger hiện —.',
  'perf.deadzoneViewHint': '↑ vùng chết trên · ↓ vùng chết dưới (mm).',
  'perf.rtTagTitle': 'Rapid Trigger · nhấn {press} mm · nhả {release} mm',
  'perf.depthShading': 'Tô độ sâu kích hoạt',
  'perf.depthShadingHint': 'Tô từ mặt phím xuống tới vạch kích hoạt: phần tô càng dài, phím càng phải nhấn sâu.',
  'perf.metricActuation': 'Actuation',
  'perf.metricRt': 'Rapid Trigger',
  'perf.metricDeadzone': 'Vùng chết',
  'perf.mode': 'Chế độ',
  'perf.modeStandard': 'Standard',
  'perf.modeRt': 'Rapid Trigger',
  'perf.modeMixed': 'Các phím đang chọn có chế độ khác nhau.',
  'perf.modeHintStandard': 'Phím kích hoạt khi nhấn qua điểm Actuation và nhả khi trở lại phía trên.',
  'perf.modeHintRt': 'Sau lần kích hoạt đầu, phím nhả ngay khi nhấc lên một đoạn và kích hoạt lại khi nhấn xuống một đoạn.',
  'perf.continuous': 'Rapid Trigger liên tục',
  'perf.continuousOnHint': 'Rapid Trigger hoạt động cho tới khi nhả hẳn phím lên đỉnh.',
  'perf.continuousOffHint': 'Rapid Trigger tắt khi phím trở lên trên điểm kích hoạt đầu; phải nhấn qua điểm đó lần nữa.',
  'perf.actuation': 'Actuation',
  'perf.actuationHintStandard': 'Độ sâu phím bắt đầu kích hoạt.',
  'perf.actuationHintRt': 'Điểm kích hoạt đầu tiên (First actuation) của Rapid Trigger.',
  'perf.rt': 'Rapid Trigger',
  'perf.rtPress': 'Độ nhạy nhấn',
  'perf.rtRelease': 'Độ nhạy nhả',
  'perf.rtLink': 'Liên kết nhấn & nhả',
  'perf.rtDisabled': 'Bật Rapid Trigger để chỉnh độ nhạy.',
  'perf.deadzones': 'Vùng chết',
  'perf.deadTop': 'Vùng chết trên',
  'perf.deadBottom': 'Vùng chết dưới',
  'perf.deadHint': 'Bỏ qua dao động nhỏ ở đầu và cuối hành trình.',
  'perf.presets': 'Mẫu cài đặt',
  'perf.presetTyping': 'Gõ phím',
  'perf.presetTypingDesc': 'Standard · 2.0 mm · chống gõ nhầm',
  'perf.presetGaming': 'Gaming',
  'perf.presetGamingDesc': 'Rapid Trigger · 1.0 mm · 0.3 / 0.3',
  'perf.presetSensitive': 'Cực nhạy',
  'perf.presetSensitiveDesc': 'Rapid Trigger · 0.3 mm · 0.1 / 0.1',
  'perf.presetApplied': 'Đã áp dụng mẫu {name} cho {n} phím.',
  'perf.tryNow': 'Thử ngay',
  'perf.tryNowHint': 'Mở Đo hành trình cho phím đang chọn',
  'perf.selectKeys': 'Chọn một hoặc nhiều phím trên bàn phím để chỉnh hành trình.',
  'perf.mixed': 'Nhiều',
  'perf.loading': 'Đang đọc cài đặt từ {n}/64 phím…',
  'perf.loadFailed': 'Không đọc được cài đặt hành trình.',
  'perf.reload': 'Đọc lại',
  'perf.editLabel': 'Hành trình · {what} ({n} phím)',
  'perf.switchLabel': 'Đổi switch · {name} ({n} phím)',
  'perf.travel': 'Hành trình phím',
  'perf.range': 'Tối đa {max} mm',
  'perf.fineHint': 'Giữ Shift khi bấm − / +, phím mũi tên hoặc kéo để chỉnh từng 0.001 mm, hoặc gõ thẳng giá trị.',
  'perf.keyLabel': 'Hành trình {key}',

  // ui kit
  'ui.close': 'Đóng',
  'ui.search': 'Tìm kiếm',
  'ui.increase': 'Tăng',
  'ui.decrease': 'Giảm',
  'ui.hue': 'Sắc độ',
  'ui.saturation': 'Độ bão hoà và độ sáng',
  'ui.recentColors': 'Màu gần đây',
  'ui.hex': 'HEX',
  'picker.search': 'Tìm phím…',
  'picker.noResults': 'Không có phím phù hợp.',
  'picker.combo': 'Tổ hợp phím',
  'picker.groups': 'Nhóm keycode',
  'picker.comboHint': 'Chọn modifier rồi chọn một phím cơ bản để tạo tổ hợp (ví dụ Ctrl+C).',
  'picker.comboClear': 'Bỏ modifier',
  'picker.current': 'Hiện tại',

  // help
  'help.title': 'AE64 Max Control',
  'help.body': 'Driver web chạy cục bộ cho Everglide AE64 Max. Kết nối qua WebHID, không cần mạng, không thu thập dữ liệu. Mọi thay đổi được ghi tự động vào phím, xác minh bằng cách đọc lại, và có thể hoàn tác (Ctrl+Z / Ctrl+Y).',
  'help.shortcuts': 'Phím tắt',
  'help.shortcutUndo': 'Hoàn tác / Làm lại',
  'help.shortcutSelect': 'Bỏ chọn phím',
  'help.safety': 'Ứng dụng không bao giờ gửi lệnh firmware (family 08) hay khôi phục cài đặt gốc.',

  // language
  'lang.switch': 'Ngôn ngữ / Language',
  'lang.vi': 'Tiếng Việt',
  'lang.en': 'English',

  // update
  'update.version': 'Phiên bản {version}',
  'update.check': 'Kiểm tra cập nhật',
  'update.checking': 'Đang kiểm tra…',
  'update.upToDate': 'Bạn đang dùng bản mới nhất',
  'update.available': 'Có bản mới {version} ({date})',
  'update.apply': 'Cập nhật',
  'update.downloading': 'Đang tải bản cập nhật…',
  'update.failed': 'Kiểm tra cập nhật thất bại: {error}',
  'update.applyFailed': 'Cập nhật thất bại: {error}',
  'update.retry': 'Thử lại',
  'update.busyWrite': 'Không thể cập nhật khi đang ghi vào bàn phím.',
  'update.busyCalibration': 'Không thể cập nhật khi đang hiệu chuẩn.',
  'update.deferred': 'Đã tải bản {version}. Sẽ áp dụng khi tải lại trang.',
  'update.reloadNow': 'Tải lại ngay',

  // protocol / hid / client / codec errors
  'error.byteRange': '{field} phải là số nguyên 0–255 (nhận {val}).',
  'error.u16Range': '{field} phải là số 16-bit không dấu (nhận {val}).',
  'error.paletteSize': 'Bảng màu cần đúng 8 màu.',
  'error.dksCount': 'DKS cần 4 keycode và 4 điểm kích hoạt.',
  'error.mptCount': 'MPT cần 3 keycode và 3 độ sâu.',
  'error.mptOrder': 'Độ sâu MPT phải dương và tăng dần.',
  'error.pairDistinct': 'Hai phím phải khác nhau.',
  'error.socdMode': 'SOCD mode phải là 0–3.',
  'error.macroDelay': 'Độ trễ macro phải từ 0 đến {max} ms.',
  'error.macroKeycode': 'Macro cần keycode 16-bit.',
  'error.macroActionsPerPage': 'Mỗi trang macro tối đa 15 thao tác.',
  'error.transportTimeout': 'Bàn phím không phản hồi lệnh {cmd}.',
  'error.boardNotAllowed': 'Bảng mạch này không nằm trong danh sách được phép ghi (chỉ AE64 Max 0030000D / Pro 0030000A).',
  'error.firmwareBlocked': 'Lệnh firmware (family 08) bị chặn trong ứng dụng này.',
  'error.hidLength': 'Gói HID vượt quá {max} byte.',
  'error.noAe64Selected': 'Chưa chọn bàn phím AE64.',
  'error.disconnected': 'Bàn phím đã bị ngắt kết nối.',
  'error.noConfigEndpoint': 'Thiết bị đã chọn không có cổng cấu hình FFB0:0001 của AE64.',
  'error.connectionClosed': 'Đã đóng kết nối bàn phím.',
  'error.openFailedOtherApp': 'Không mở được bàn phím. Hãy đóng các trình driver khác (hub.xsyd.top, tab khác) rồi thử lại.',
  'error.noWebHid': 'Trình duyệt không hỗ trợ WebHID. Hãy dùng Chrome hoặc Edge bản desktop.',
  'error.modifierRequired': 'Chọn ít nhất một modifier.',
  'error.comboTriggerStandard': 'Phím kích hoạt phải là phím bàn phím tiêu chuẩn.',

  // keycodes
  'key.emptyDesc': 'Empty (không gán)',
  'key.transDesc': 'Transparent (dùng phím lớp dưới)',
  'key.groupBasic': 'Cơ bản',
  'key.groupNavigation': 'Điều hướng',
  'key.groupMouse': 'Chuột',
  'key.groupLighting': 'Đèn',
  'key.groupSpecial': 'Đặc biệt',
} as const;

export const vi = {
  ...base,
  ...keymapVi,
  ...settingsVi,
  ...diagnosticsVi,
  ...advancedVi,
  ...macroVi,
  ...lightingVi,
  ...liveVi,
  ...calibrationVi,
  ...performanceVi,
} as const;

export type MessageKey = keyof typeof vi;

/** Look up a string; `{name}` placeholders come from params, `{n|# one|# other}` picks a plural form (see locale.ts). */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const current = locale.value;
  const table = current === 'en' ? (en as unknown as Record<string, string>) : (vi as unknown as Record<string, string>);
  const s: string = table[key] ?? (vi as unknown as Record<string, string>)[key] ?? key;
  return params ? applyPlurals(s, params).replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`)) : s;
}
