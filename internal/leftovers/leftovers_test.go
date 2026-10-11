package leftovers

import "testing"

// BaseName 是残留匹配的地基：名字规范化错了，后面所有目录匹配都会失准。
func TestBaseName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Adobe Photoshop CS6", "Adobe Photoshop CS6"},
		{"Adobe Photoshop (x64)", "Adobe Photoshop"},
		{"Notepad++ (64-bit)", "Notepad++"},
		{"Foo 3.5.1", "Foo"},
		{"Bar v2", "Bar"},
		{"Baz 2024", "Baz"},
		// 版本号出现在中间也要截断（Rust 版用 take_while，语义相同）
		{"My App 2.0 Professional", "My App"},
		{"Plain Name", "Plain Name"},
		// 全部都是版本词时 keep 为空，要退回整串而不是返回空
		{"3.5.1", "3.5.1"},
		// 括号里含嵌套括号
		{"App (x64) Extra", "App Extra"},
	}
	for _, c := range cases {
		if got := BaseName(c.in); got != c.want {
			t.Errorf("BaseName(%q) = %q, 期望 %q", c.in, got, c.want)
		}
	}
}

func TestVendorName(t *testing.T) {
	cases := []struct {
		in   string
		want string
		ok   bool
	}{
		// 「Software」也在 Rust 版的后缀表里，会被一起去掉：
		// "Foo Software, Inc." → "Foo"，这正是 <厂商>\<产品> 目录能匹配上的原因。
		{"Foo Software, Inc.", "Foo", true},
		{"Microsoft Corporation", "Microsoft", true},
		{"  Acme  Ltd. ", "Acme", true},
		{"GmbH", "", false}, // 全是法律后缀 → 没有可用厂商名
		{"", "", false},
	}
	for _, c := range cases {
		got, ok := VendorName(c.in)
		if ok != c.ok || got != c.want {
			t.Errorf("VendorName(%q) = (%q, %v), 期望 (%q, %v)", c.in, got, ok, c.want, c.ok)
		}
	}
}

// PackGUID 是 MSI 残留能否被找到的关键：算法错了 Installer\Products 下一个键都匹配不上。
//
// Windows Installer 的打包规则：去掉花括号与横线后，前三组（8-4-4）整组倒序，
// 最后 16 个十六进制位按 **每 2 位一组**倒序。这个期望值是按该规则手工推出来的
// （8A69D345→543D96A8、D564→465D、463C→C364、AF→FA …），与 Rust 版 pack_guid 同源。
func TestPackGUID(t *testing.T) {
	got := PackGUID("{8A69D345-D564-463C-AFF1-A69D9E530F96}")
	want := "543D96A8465DC364FA1F6AD9E935F069"
	if got != want {
		t.Errorf("PackGUID = %q, 期望 %q", got, want)
	}
	// 非 GUID 输入原样返回长度不足的十六进制串
	if got := PackGUID("not-a-guid"); got == "" {
		t.Error("非 GUID 输入不应返回空串")
	}
}

// DisplayIcon 的形状非常脏，这里锁住几种真实存在的写法。
func TestExeFromDisplayIcon(t *testing.T) {
	cases := []struct{ in, want string }{
		{`"C:\Program Files\Foo\foo.exe",0`, `C:\Program Files\Foo\foo.exe`},
		{`C:\Program Files\Foo\foo.exe`, `C:\Program Files\Foo\foo.exe`},
		{`C:\Windows\notepad.exe,3`, `C:\Windows\notepad.exe`},
		{`C:\Windows\System32\shell32.dll,-1`, `C:\Windows\System32\shell32.dll`},
		{`C:\path\app.ico`, `C:\path\app.ico`},
	}
	for _, c := range cases {
		got, ok := ExeFromDisplayIcon(c.in)
		if !ok || got != c.want {
			t.Errorf("ExeFromDisplayIcon(%q) = (%q, %v), 期望 %q", c.in, got, ok, c.want)
		}
	}
	if _, ok := ExeFromDisplayIcon("C:\\some\\file.txt"); ok {
		t.Error("不可执行扩展名不应被接受")
	}
}

// 驱动器根必须始终受保护。
func TestIsProtectedDriveRoot(t *testing.T) {
	if !IsProtected(`C:\`) {
		t.Error("驱动器根必须受保护")
	}
	if !IsProtected(`C:`) {
		t.Error("驱动器根（无反斜杠）必须受保护")
	}
}

// 保护清单是误删的最后一道闸。
func TestIsProtectedKey(t *testing.T) {
	// 深度 < 3 的键一律拒绝
	for _, p := range []string{
		`HKLM\SOFTWARE`,
		`HKLM\SOFTWARE\Foo`,
		`HKCU\Software\Bar`,
	} {
		if !IsProtectedKey(p) {
			t.Errorf("%s 应当受保护（层级过浅）", p)
		}
	}
	// 关键的系统子树
	for _, p := range []string{
		`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`,
		`HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`,
		`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion`,
		`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager`,
		`HKLM\SOFTWARE\Classes`,
	} {
		if !IsProtectedKey(p) {
			t.Errorf("%s 应当受保护", p)
		}
	}
	// 正常的应用级键允许删除
	for _, p := range []string{
		`HKCU\Software\Foo\Bar`,
		`HKLM\SOFTWARE\Vendor\Product\Settings`,
		`HKCU\Software\Classes\Applications\foo.exe`,
	} {
		if IsProtectedKey(p) {
			t.Errorf("%s 不应受保护", p)
		}
	}
}
