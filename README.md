# Đổi File Văn Phòng — Kênh cập nhật & quản lý

Repo này chứa file cấu hình từ xa cho phần mềm **Đổi File Văn Phòng**.

## `config.json`

| Trường | Ý nghĩa |
|---|---|
| `enabled` | `true` = phần mềm hoạt động bình thường. Đổi thành `false` → **tất cả máy đã cài sẽ bị khóa** ngay lần mở tiếp theo. |
| `message` | Thông báo hiện ra khi bị khóa (để trống sẽ dùng câu mặc định). |
| `latest_version` | Phiên bản mới nhất. Lớn hơn bản đang cài → app hiện nút "Cập nhật ngay". |
| `download_url` | Link tải bộ cài bản mới (mặc định trỏ vào Release mới nhất của repo này). |
| `notes` | Ghi chú ngắn về bản mới (hiện trên thanh cập nhật). |
| `report_url` | Nơi nhận báo lỗi tự động từ app (API hoặc Discord webhook). |

## Cách khóa phần mềm (khi nghỉ việc)

1. Mở file `config.json` trên GitHub (điện thoại cũng được) → Edit.
2. Sửa `"enabled": true` thành `"enabled": false`.
3. Commit. Xong — mọi máy sẽ bị khóa trong lần mở kế tiếp (tối đa sau 14 ngày với máy mất mạng).

## Cách phát hành bản mới

1. Build `Setup-DoiFileVanPhong.exe` mới.
2. Tạo Release tag `vX.Y.Z`, đính kèm file với **đúng tên** `Setup-DoiFileVanPhong.exe`.
3. Sửa `latest_version` trong `config.json` thành `X.Y.Z` (+ `notes` nếu muốn).
