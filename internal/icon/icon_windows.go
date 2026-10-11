//go:build windows

package icon

import (
	"bytes"
	"image"
	"image/png"
	"os"
	"syscall"
	"unsafe"

	"duster/internal/model"
)

var (
	shell32 = syscall.NewLazyDLL("shell32.dll")
	user32  = syscall.NewLazyDLL("user32.dll")
	gdi32   = syscall.NewLazyDLL("gdi32.dll")

	procExtractIconExW = shell32.NewProc("ExtractIconExW")
	procGetIconInfo    = user32.NewProc("GetIconInfo")
	procDestroyIcon    = user32.NewProc("DestroyIcon")
	procGetObjectW     = gdi32.NewProc("GetObjectW")
	procGetDIBits      = gdi32.NewProc("GetDIBits")
	procDeleteObject   = gdi32.NewProc("DeleteObject")
	procGetDC          = user32.NewProc("GetDC")
	procReleaseDC      = user32.NewProc("ReleaseDC")
)

// iconInfo 与 Win32 的 ICONINFO 一致。
type iconInfo struct {
	FSMasks  uint32
	XHotspot uint32
	YHotspot uint32
	HBMMask  uintptr
	HBMColor uintptr
}

// bitmap 与 Win32 的 BITMAP 一致（用于读出图标位图的尺寸）。
type bitmap struct {
	Type       uint32
	Width      int32
	Height     int32
	WidthBytes uint32
	Planes     uint16
	BitsPixel  uint16
	Bits       uintptr
}

// bitmapInfoHeader 与 Win32 的 BITMAPINFOHEADER 一致。
type bitmapInfoHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

// bitmapInfo 与 Win32 的 BITMAPINFO 一致（头部 + 一个 RGBQUAD）。
type bitmapInfo struct {
	Header bitmapInfoHeader
	Colors [1][4]byte
}

const dibRGBColors = 0

var errBadIndex = errorString("图标索引不是合法整数")

type errorString string

func (e errorString) Error() string { return string(e) }

// ExtractPNGDataURL 提取某个程序的图标，返回 PNG data URL；取不到返回空串。
func ExtractPNGDataURL(app model.InstalledApp) string {
	for _, c := range Candidates(app) {
		path, _ := c[0].(string)
		index, _ := c[1].(int32)
		if png, ok := extractFromFile(path, index); ok {
			return PNGDataURL(png)
		}
	}
	return ""
}

// extractFromFile 用 ExtractIconExW + GDI 把图标位图取出来编码成 PNG。
func extractFromFile(path string, index int32) ([]byte, bool) {
	if st, err := os.Stat(path); err != nil || st.IsDir() {
		return nil, false
	}
	pathPtr, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, false
	}

	// largeIcons 只取大尺寸：列表里显示的是 32px 左右，
	// 小尺寸的图标在高分屏上会被放大得很难看。
	var large [1]uintptr
	ret, _, _ := syscall.SyscallN(
		procExtractIconExW.Addr(),
		uintptr(unsafe.Pointer(pathPtr)), uintptr(index),
		uintptr(unsafe.Pointer(&large[0])), 0, 1,
	)
	if ret == 0 || large[0] == 0 {
		return nil, false
	}
	hicon := large[0]
	defer func() { _, _, _ = syscall.SyscallN(procDestroyIcon.Addr(), hicon) }()

	var info iconInfo
	if r, _, _ := syscall.SyscallN(procGetIconInfo.Addr(), hicon,
		uintptr(unsafe.Pointer(&info))); r == 0 {
		return nil, false
	}
	// 释放位图句柄：GDI 对象不释放会一直占着，图标多了直接把 GDI 配额耗光。
	defer func() {
		if info.HBMMask != 0 {
			_, _, _ = syscall.SyscallN(procDeleteObject.Addr(), info.HBMMask)
		}
		if info.HBMColor != 0 {
			_, _, _ = syscall.SyscallN(procDeleteObject.Addr(), info.HBMColor)
		}
	}()

	// 先读出尺寸，再按尺寸取像素。
	var bmp bitmap
	if r, _, _ := syscall.SyscallN(procGetObjectW.Addr(), info.HBMColor,
		uintptr(unsafe.Sizeof(bitmap{})),
		uintptr(unsafe.Pointer(&bmp))); r == 0 {
		return nil, false
	}
	width, height := bmp.Width, bmp.Height
	if width <= 0 || height <= 0 {
		return nil, false
	}

	info2 := bitmapInfo{Header: bitmapInfoHeader{
		Size:     uint32(unsafe.Sizeof(bitmapInfoHeader{})),
		Width:    width,
		Height:   -height, // 负高度 = 自上而下，省一次翻转
		Planes:   1,
		BitCount: 32,
	}}
	pixels := make([]byte, int(width)*int(height)*4)

	hdc, _, _ := syscall.SyscallN(procGetDC.Addr(), 0)
	defer func() {
		if hdc != 0 {
			_, _, _ = syscall.SyscallN(procReleaseDC.Addr(), 0, hdc)
		}
	}()

	lines, _, _ := syscall.SyscallN(
		procGetDIBits.Addr(), hdc, info.HBMColor, 0, uintptr(uint32(height)),
		uintptr(unsafe.Pointer(&pixels[0])),
		uintptr(unsafe.Pointer(&info2)), dibRGBColors,
	)
	if lines == 0 {
		return nil, false
	}

	// BGRA → RGBA。
	//
	// 无 alpha 通道的旧式图标取回来 alpha 全 0，直接贴到界面上是全透明。
	// 所以先探测「有没有非零 alpha」，没有就整体置 255 ——
	// 否则图标会整个消失，而且没有任何报错（Rust 版踩过同样的坑）。
	hasAlpha := false
	for i := 3; i < len(pixels); i += 4 {
		if pixels[i] != 0 {
			hasAlpha = true
			break
		}
	}
	for i := 0; i < len(pixels); i += 4 {
		pixels[i], pixels[i+2] = pixels[i+2], pixels[i]
		if !hasAlpha {
			pixels[i+3] = 255
		}
	}
	return encodePNG(width, height, pixels)
}

// encodePNG 把 RGBA 像素编码成 PNG。
func encodePNG(width, height int32, rgba []byte) ([]byte, bool) {
	img := image.NewRGBA(image.Rect(0, 0, int(width), int(height)))
	copy(img.Pix, rgba)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, false
	}
	return buf.Bytes(), true
}
