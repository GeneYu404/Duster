package uninstaller

import "testing"

// 这四个用例逐条对应 Rust 侧 uninstaller.rs 的 #[cfg(test)] mod tests，
// 保证解析行为在换语言后没有漂移。
func TestParseCommand_NormalisesMSIExec(t *testing.T) {
	p, err := ParseCommand(`MsiExec.exe /I{8A69D345-D564-463C-AFF1-A69D9E530F96}`, true)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	want := "msiexec.exe /x {8A69D345-D564-463C-AFF1-A69D9E530F96} /qn /norestart"
	if p.Normalized != want {
		t.Errorf("normalized = %q, 期望 %q", p.Normalized, want)
	}
	if !p.IsMSI {
		t.Error("IsMSI 应为 true")
	}
}

func TestParseCommand_NormalisesQuotedMSIPath(t *testing.T) {
	p, err := ParseCommand(`"C:\Windows\System32\MsiExec.exe" /I{8A69D345-D564-463C-AFF1-A69D9E530F96}`, false)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	want := "msiexec.exe /x {8A69D345-D564-463C-AFF1-A69D9E530F96}"
	if p.Normalized != want {
		t.Errorf("normalized = %q, 期望 %q", p.Normalized, want)
	}
	// 非静默模式不该补 /qn /norestart
	if p.Args != "/x {8A69D345-D564-463C-AFF1-A69D9E530F96}" {
		t.Errorf("args = %q", p.Args)
	}
}

func TestParseCommand_HandlesQuotedPaths(t *testing.T) {
	p, err := ParseCommand(`"C:\Program Files\Foo Bar\unins000.exe" /SILENT`, false)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if p.Program != `C:\Program Files\Foo Bar\unins000.exe` {
		t.Errorf("program = %q", p.Program)
	}
	if p.Args != "/SILENT" {
		t.Errorf("args = %q", p.Args)
	}
}

func TestParseCommand_HandlesUnquotedPathsWithSpaces(t *testing.T) {
	p, err := ParseCommand(`C:\Program Files\Foo\uninstall.exe --uninstall -s`, false)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if p.Program != `C:\Program Files\Foo\uninstall.exe` {
		t.Errorf("program = %q", p.Program)
	}
	if p.Args != "--uninstall -s" {
		t.Errorf("args = %q", p.Args)
	}
}

// 以下是 Rust 版没有覆盖、但换语言后容易写错的边界。
func TestParseCommand_RejectsEmpty(t *testing.T) {
	if _, err := ParseCommand("   ", false); err == nil {
		t.Error("空命令应当报错")
	}
}

func TestParseCommand_NoDuplicateQuietFlags(t *testing.T) {
	// 原命令已带 /qn /norestart，不能再追加一遍
	p, err := ParseCommand(`msiexec.exe /x {8A69D345-D564-463C-AFF1-A69D9E530F96} /qn /norestart`, true)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if got := p.Args; got != "/x {8A69D345-D564-463C-AFF1-A69D9E530F96} /qn /norestart" {
		t.Errorf("args = %q, 静默标志被重复追加", got)
	}
}

// 环境变量必须被展开；不存在的变量要原样保留（见 ExpandEnvironment 注释）。
func TestExpandEnvironment(t *testing.T) {
	t.Setenv("DUSTER_TEST_DIR", `C:\Program Files\Foo`)
	if got := ExpandEnvironment(`"%DUSTER_TEST_DIR%\unins.exe" /S`); got != `"C:\Program Files\Foo\unins.exe" /S` {
		t.Errorf("已存在的变量未展开: %q", got)
	}
	if got := ExpandEnvironment(`%DUSTER_NOT_SET_ANYWHERE%\x.exe`); got != `%DUSTER_NOT_SET_ANYWHERE%\x.exe` {
		t.Errorf("不存在的变量应原样保留: %q", got)
	}
}

// 退出码表的行为锁定。
func TestDescribeExitCode(t *testing.T) {
	cases := []struct {
		code    int32
		success bool
		cancel  bool
		reboot  bool
	}{
		{0, true, false, false},
		{3010, true, false, true},
		{1641, true, false, true},
		{1602, false, true, false},
		{1223, false, true, false},
		{1605, true, false, false},
		{1603, false, false, false},
		{1618, false, false, false},
		{9999, false, false, false},
	}
	for _, c := range cases {
		v := DescribeExitCode(c.code)
		if v.Success != c.success || v.Cancelled != c.cancel || v.RebootNeeded != c.reboot {
			t.Errorf("code %d → %+v, 期望 success=%v cancel=%v reboot=%v",
				c.code, v, c.success, c.cancel, c.reboot)
		}
	}
}
