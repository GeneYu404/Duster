import type { AppKind, Architecture, InstalledApp } from '../types/app';
import { fnvHex } from '../utils/format';

/* ------------------------------------------------------------------ */
/* Deterministic PRNG so the preview data is stable between reloads.   */
/* ------------------------------------------------------------------ */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HKLM64 = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const HKLM32 = 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const HKCU = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
export const USER_PROFILE = 'C:\\Users\\Alex';

interface Seed {
  n: string; // name
  p: string; // publisher
  mb: number; // size in MB
  q?: boolean; // has quiet uninstall string
  msi?: boolean;
  cu?: boolean; // per-user (HKCU)
  x86?: boolean;
  v?: string;
  dir?: string; // folder name override
  exe?: string;
  broken?: boolean; // uninstaller file missing
  sys?: boolean; // SystemComponent = 1
  help?: string;
  noCmd?: boolean; // no UninstallString at all
}

const PROGRAMS: Seed[] = [
  { n: 'Google Chrome', p: 'Google LLC', mb: 620, v: '125.0.6422.113', dir: 'Google\\Chrome\\Application', exe: 'chrome', help: 'https://support.google.com/chrome' },
  { n: 'Mozilla Firefox (x64 zh-CN)', p: 'Mozilla', mb: 240, q: true, v: '126.0.1', dir: 'Mozilla Firefox', exe: 'firefox', help: 'https://support.mozilla.org' },
  { n: 'Microsoft Edge', p: 'Microsoft Corporation', mb: 580, v: '125.0.2535.67', x86: true, dir: 'Microsoft\\Edge\\Application', exe: 'msedge' },
  { n: 'Microsoft Visual Studio Code (User)', p: 'Microsoft Corporation', mb: 380, q: true, cu: true, v: '1.89.1', dir: 'Microsoft VS Code', exe: 'Code' },
  { n: 'Git', p: 'The Git Development Community', mb: 310, q: true, v: '2.45.1', exe: 'git-bash' },
  { n: 'Node.js', p: 'Node.js Foundation', mb: 95, msi: true, v: '20.13.1', dir: 'nodejs', exe: 'node' },
  { n: 'Python 3.12.3 (64-bit)', p: 'Python Software Foundation', mb: 105, q: true, cu: true, v: '3.12.3150.0', dir: 'Python\\Python312', exe: 'python' },
  { n: '7-Zip 23.01 (x64)', p: 'Igor Pavlov', mb: 5, v: '23.01', dir: '7-Zip', exe: '7zFM' },
  { n: 'VLC media player', p: 'VideoLAN', mb: 160, q: true, v: '3.0.20', dir: 'VideoLAN\\VLC', exe: 'vlc' },
  { n: 'Notepad++ (64-bit x64)', p: 'Notepad++ Team', mb: 16, q: true, v: '8.6.7', dir: 'Notepad++', exe: 'notepad++' },
  { n: 'Docker Desktop', p: 'Docker Inc.', mb: 2400, v: '4.30.0', dir: 'Docker\\Docker', exe: 'Docker Desktop' },
  { n: 'Steam', p: 'Valve Corporation', mb: 4200, x86: true, v: '2.10.91.91', dir: 'Steam', exe: 'steam' },
  { n: 'Discord', p: 'Discord Inc.', mb: 290, q: true, cu: true, v: '1.0.9150', dir: 'Discord', exe: 'Update' },
  { n: 'Spotify', p: 'Spotify AB', mb: 310, q: true, cu: true, v: '1.2.37.701', dir: 'Spotify', exe: 'Spotify' },
  { n: 'Zoom Workplace', p: 'Zoom Video Communications, Inc.', mb: 230, q: true, cu: true, v: '6.0.11', dir: 'Zoom\\bin', exe: 'Zoom' },
  { n: 'Slack', p: 'Slack Technologies, LLC', mb: 180, q: true, cu: true, v: '4.38.125', dir: 'slack', exe: 'slack' },
  { n: 'OBS Studio', p: 'OBS Project', mb: 410, q: true, v: '30.1.2', dir: 'obs-studio', exe: 'bin\\64bit\\obs64' },
  { n: 'Blender', p: 'Blender Foundation', mb: 780, msi: true, v: '4.1.1', dir: 'Blender Foundation\\Blender 4.1', exe: 'blender' },
  { n: 'GIMP 2.10.36', p: 'The GIMP Team', mb: 920, q: true, v: '2.10.36', dir: 'GIMP 2', exe: 'bin\\gimp-2.10' },
  { n: 'Audacity 3.5.1', p: 'Audacity Team', mb: 90, q: true, v: '3.5.1', dir: 'Audacity', exe: 'Audacity' },
  { n: 'HandBrake 1.7.3', p: 'HandBrake Team', mb: 70, q: true, v: '1.7.3', dir: 'HandBrake', exe: 'HandBrake' },
  { n: 'PowerToys (Preview) x64', p: 'Microsoft Corporation', mb: 450, msi: true, v: '0.81.1', dir: 'PowerToys', exe: 'PowerToys' },
  { n: 'WinRAR 7.01 (64-bit)', p: 'win.rar GmbH', mb: 12, v: '7.01.0', dir: 'WinRAR', exe: 'WinRAR' },
  { n: 'Everything 1.4.1.1024 (x64)', p: 'voidtools', mb: 4, q: true, v: '1.4.1.1024', dir: 'Everything', exe: 'Everything' },
  { n: 'ShareX', p: 'ShareX Team', mb: 25, q: true, v: '16.1.0', dir: 'ShareX', exe: 'ShareX' },
  { n: 'PuTTY release 0.81 (64-bit)', p: 'Simon Tatham', mb: 8, msi: true, v: '0.81.0.0', dir: 'PuTTY', exe: 'putty' },
  { n: 'WinSCP 6.3.3', p: 'Martin Prikryl', mb: 45, q: true, x86: true, v: '6.3.3', dir: 'WinSCP', exe: 'WinSCP' },
  { n: 'FileZilla Client 3.67.0', p: 'Tim Kosse', mb: 40, q: true, v: '3.67.0', dir: 'FileZilla FTP Client', exe: 'filezilla' },
  { n: 'Postman x86_64 11.2.3', p: 'Postman', mb: 480, q: true, cu: true, v: '11.2.3', dir: 'Postman', exe: 'Postman' },
  { n: 'IntelliJ IDEA 2024.1.2', p: 'JetBrains s.r.o.', mb: 3100, q: true, v: '241.17011.79', dir: 'JetBrains\\IntelliJ IDEA 2024.1.2', exe: 'bin\\idea64' },
  { n: 'PyCharm Community Edition 2024.1.1', p: 'JetBrains s.r.o.', mb: 1900, q: true, v: '241.15989.155', dir: 'JetBrains\\PyCharm Community Edition 2024.1.1', exe: 'bin\\pycharm64' },
  { n: 'Android Studio', p: 'Google LLC', mb: 2700, q: true, v: '2023.3', dir: 'Android\\Android Studio', exe: 'bin\\studio64' },
  { n: 'Oracle VirtualBox 7.0.18', p: 'Oracle Corporation', mb: 230, msi: true, v: '7.0.18', dir: 'Oracle\\VirtualBox', exe: 'VirtualBox' },
  { n: 'VMware Workstation', p: 'Broadcom', mb: 1200, msi: true, x86: true, v: '17.5.2', dir: 'VMware\\VMware Workstation', exe: 'vmware' },
  { n: 'NVIDIA Graphics Driver 552.44', p: 'NVIDIA Corporation', mb: 1100, v: '552.44', dir: 'NVIDIA Corporation\\Installer2', exe: 'InstallerCore\\NVI2.DLL', noCmd: false },
  { n: 'NVIDIA GeForce Experience 3.27.0.120', p: 'NVIDIA Corporation', mb: 230, v: '3.27.0.120', dir: 'NVIDIA Corporation\\NVIDIA GeForce Experience', exe: 'NVIDIA GeForce Experience' },
  { n: 'NVIDIA PhysX System Software 9.23.1019', p: 'NVIDIA Corporation', mb: 90, msi: true, x86: true, v: '9.23.1019', dir: 'NVIDIA Corporation\\PhysX', exe: 'Common\\PhysXCore' },
  { n: 'Realtek High Definition Audio Driver', p: 'Realtek Semiconductor Corp.', mb: 130, x86: true, v: '6.0.9239.1', dir: 'Realtek\\Audio\\HDA', exe: 'RtkNGUI64' },
  { n: 'Logitech G HUB', p: 'Logitech', mb: 480, v: '2024.4.6', dir: 'LGHUB', exe: 'lghub' },
  { n: 'Adobe Acrobat (64-bit)', p: 'Adobe', mb: 1200, msi: true, v: '24.002.20759', dir: 'Adobe\\Acrobat DC\\Acrobat', exe: 'Acrobat' },
  { n: 'Adobe Creative Cloud', p: 'Adobe Inc.', mb: 950, v: '6.2.0.554', dir: 'Adobe\\Adobe Creative Cloud\\ACC', exe: 'Creative Cloud' },
  { n: 'Microsoft 365 Apps for enterprise - zh-cn', p: 'Microsoft Corporation', mb: 4500, v: '16.0.17628.20144', dir: 'Microsoft Office\\root\\Office16', exe: 'WINWORD', noCmd: false },
  { n: 'Microsoft OneDrive', p: 'Microsoft Corporation', mb: 290, cu: true, v: '24.091.0505.0001', dir: 'Microsoft OneDrive', exe: 'OneDrive' },
  { n: 'Microsoft Teams', p: 'Microsoft Corporation', mb: 220, q: true, cu: true, v: '1.7.00.9257', dir: 'Microsoft\\Teams\\current', exe: 'Teams' },
  { n: 'Visual Studio Community 2022', p: 'Microsoft Corporation', mb: 12000, v: '17.10.0', x86: true, dir: 'Microsoft Visual Studio\\2022\\Community', exe: 'Common7\\IDE\\devenv' },
  { n: 'SQL Server Management Studio 20.1', p: 'Microsoft Corporation', mb: 1900, v: '20.1.10.0', x86: true, dir: 'Microsoft SQL Server Management Studio 20\\Common7\\IDE', exe: 'Ssms' },
  { n: '微信', p: '腾讯科技(深圳)有限公司', mb: 680, x86: true, v: '3.9.10.27', dir: 'Tencent\\WeChat', exe: 'WeChat' },
  { n: 'QQ', p: '腾讯科技(深圳)有限公司', mb: 540, v: '9.9.10', dir: 'Tencent\\QQNT', exe: 'QQ' },
  { n: '腾讯会议', p: '腾讯科技(深圳)有限公司', mb: 350, v: '3.26.5.410', dir: 'Tencent\\WeMeet', exe: 'wemeetapp' },
  { n: '钉钉', p: '钉钉(中国)信息技术有限公司', mb: 600, x86: true, v: '7.5.45', dir: 'DingDing', exe: 'DingtalkLauncher' },
  { n: '网易云音乐', p: '网易(杭州)网络有限公司', mb: 300, x86: true, v: '3.0.10', dir: 'Netease\\CloudMusic', exe: 'cloudmusic' },
  { n: '百度网盘', p: '百度在线网络技术（北京）有限公司', mb: 420, x86: true, v: '7.42.1.5', dir: 'Baidu\\BaiduNetdisk', exe: 'BaiduNetdisk' },
  { n: '迅雷', p: '深圳市迅雷网络技术有限公司', mb: 380, x86: true, v: '12.0.6.2200', dir: 'Thunder Network\\Thunder', exe: 'Program\\Thunder' },
  { n: 'WPS Office', p: 'Kingsoft Corp.', mb: 900, x86: true, cu: true, v: '12.1.0.16729', dir: 'Kingsoft\\WPS Office', exe: 'ksolaunch' },
  { n: '搜狗输入法 14.5', p: 'Sogou.com', mb: 200, x86: true, v: '14.5.0.9316', dir: 'SogouInput', exe: 'SGTool' },
  { n: 'Bandizip', p: 'Bandisoft.com', mb: 20, q: true, v: '7.33', dir: 'Bandizip', exe: 'Bandizip' },
  { n: 'Snipaste', p: 'Snipaste', mb: 15, cu: true, v: '2.9.3', dir: 'Snipaste', exe: 'Snipaste' },
  { n: 'PotPlayer 64 bit', p: 'Kakao Corp.', mb: 60, q: true, v: '1.7.22218', dir: 'DAUM\\PotPlayer', exe: 'PotPlayerMini64' },
  { n: 'Typora', p: 'typora.io', mb: 180, q: true, v: '1.8.10', dir: 'Typora', exe: 'Typora' },
  { n: 'Obsidian', p: 'Dynalist Inc.', mb: 290, q: true, cu: true, v: '1.5.12', dir: 'Obsidian', exe: 'Obsidian' },
  { n: 'Notion', p: 'Notion Labs, Inc.', mb: 300, q: true, cu: true, v: '3.8.0', dir: 'Notion', exe: 'Notion' },
  { n: 'Figma', p: 'Figma, Inc.', mb: 250, q: true, cu: true, v: '124.3.5', dir: 'Figma', exe: 'Figma' },
  { n: 'Telegram Desktop', p: 'Telegram FZ-LLC', mb: 120, q: true, cu: true, v: '5.0.1', dir: 'Telegram Desktop', exe: 'Telegram' },
  { n: 'qBittorrent', p: 'The qBittorrent project', mb: 90, q: true, v: '4.6.5', dir: 'qBittorrent', exe: 'qbittorrent' },
  { n: 'CCleaner', p: 'Piriform Software Ltd', mb: 70, q: true, v: '6.24', dir: 'CCleaner', exe: 'CCleaner64' },
  { n: 'TeamViewer', p: 'TeamViewer', mb: 160, q: true, x86: true, v: '15.54.6', dir: 'TeamViewer', exe: 'TeamViewer' },
  { n: 'AnyDesk', p: 'AnyDesk Software GmbH', mb: 10, q: true, x86: true, v: 'ad 8.0.11', dir: 'AnyDesk', exe: 'AnyDesk' },
  { n: 'Wireshark 4.2.5 x64', p: 'The Wireshark developer community', mb: 230, q: true, v: '4.2.5', dir: 'Wireshark', exe: 'Wireshark' },
  { n: 'Nmap 7.95', p: 'Nmap Project', mb: 110, x86: true, v: '7.95', dir: 'Nmap', exe: 'zenmap' },
  { n: 'Rustup: the Rust toolchain installer', p: 'The Rust Project Developers', mb: 1500, cu: true, v: '1.27.1', dir: '.cargo\\bin', exe: 'rustup' },
  { n: 'Go Programming Language amd64 go1.22.3', p: 'https://go.dev', mb: 250, msi: true, v: '1.22.3', dir: 'Go', exe: 'bin\\go' },
  { n: 'Java 8 Update 411 (64-bit)', p: 'Oracle Corporation', mb: 180, msi: true, v: '8.0.4110.9', dir: 'Java\\jre-1.8', exe: 'bin\\javaw' },
  { n: 'Eclipse Temurin JDK with Hotspot 17.0.11+9 (x64)', p: 'Eclipse Adoptium', mb: 320, msi: true, v: '17.0.11.9', dir: 'Eclipse Adoptium\\jdk-17.0.11.9-hotspot', exe: 'bin\\java' },
  { n: 'MySQL Server 8.0', p: 'Oracle Corporation', mb: 700, msi: true, v: '8.0.37', dir: 'MySQL\\MySQL Server 8.0', exe: 'bin\\mysqld' },
  { n: 'PostgreSQL 16', p: 'PostgreSQL Global Development Group', mb: 500, q: true, v: '16.3-1', dir: 'PostgreSQL\\16', exe: 'bin\\pgAdmin4' },
  { n: 'Cursor', p: 'Anysphere, Inc.', mb: 400, q: true, cu: true, v: '0.34.6', dir: 'cursor', exe: 'Cursor' },
  { n: 'Epic Games Launcher', p: 'Epic Games, Inc.', mb: 600, msi: true, x86: true, v: '1.3.98.0', dir: 'Epic Games\\Launcher', exe: 'Portal\\Binaries\\Win64\\EpicGamesLauncher' },
  { n: 'Ubisoft Connect', p: 'Ubisoft', mb: 300, x86: true, v: '154.0.11129', dir: 'Ubisoft\\Ubisoft Game Launcher', exe: 'UbisoftConnect' },
  { n: 'EA app', p: 'Electronic Arts', mb: 400, v: '13.206.0.5844', dir: 'Electronic Arts\\EA Desktop\\EA Desktop', exe: 'EADesktop' },
  { n: 'Battle.net', p: 'Blizzard Entertainment', mb: 500, x86: true, v: '2.33.0.15354', dir: 'Battle.net', exe: 'Battle.net Launcher' },
  { n: 'GOG GALAXY', p: 'GOG.com', mb: 350, x86: true, v: '2.0.73.4', dir: 'GOG Galaxy', exe: 'GalaxyClient' },
  { n: 'Microsoft Edge WebView2 Runtime', p: 'Microsoft Corporation', mb: 540, x86: true, v: '125.0.2535.67', dir: 'Microsoft\\EdgeWebView\\Application', exe: 'msedgewebview2' },
  { n: 'Microsoft Edge Update', p: 'Microsoft Corporation', mb: 8, x86: true, v: '1.3.187.37', dir: 'Microsoft\\EdgeUpdate', exe: 'MicrosoftEdgeUpdate', sys: true },
  { n: 'Google Update Helper', p: 'Google LLC', mb: 1, msi: true, x86: true, v: '1.3.36.372', dir: 'Google\\Update', exe: 'GoogleUpdate', sys: true },
  { n: 'Mozilla Maintenance Service', p: 'Mozilla', mb: 1, x86: true, v: '126.0.1', dir: 'Mozilla Maintenance Service', exe: 'maintenanceservice' },
  { n: 'Bonjour', p: 'Apple Inc.', mb: 12, msi: true, v: '3.1.0.1', dir: 'Bonjour', exe: 'mDNSResponder' },
  { n: 'Apple Software Update', p: 'Apple Inc.', mb: 6, msi: true, x86: true, v: '2.6.3.1', dir: 'Apple Software Update', exe: 'SoftwareUpdate' },
  { n: 'iTunes', p: 'Apple Inc.', mb: 480, msi: true, v: '12.13.2.3', dir: 'iTunes', exe: 'iTunes' },
  { n: 'Vulkan Run Time Libraries 1.3.280.0', p: 'LunarG, Inc.', mb: 4, v: '1.3.280.0', dir: 'VulkanRT\\1.3.280.0', exe: 'vulkaninfo' },
  { n: 'OpenAL', p: 'Creative Labs', mb: 1, x86: true, v: '2.0.7.0', dir: 'OpenAL', exe: 'oalinst' },
  { n: 'Microsoft XNA Framework Redistributable 4.0', p: 'Microsoft Corporation', mb: 7, msi: true, x86: true, v: '4.0.20823.0', dir: 'Microsoft XNA\\XNA Game Studio\\v4.0', exe: 'Redist\\xnafx40_redist' },
  { n: 'Windows Subsystem for Linux', p: 'Microsoft Corporation', mb: 240, msi: true, v: '2.1.5.0', dir: 'WSL', exe: 'wsl' },
  { n: 'Old Photo Organizer 2.4', p: 'Sunset Softworks', mb: 85, v: '2.4.0', dir: 'Sunset Softworks\\Photo Organizer', exe: 'PhotoOrganizer', broken: true },
  { n: 'QuickBurner Lite', p: 'Nebula Tools', mb: 22, x86: true, v: '1.1.3', dir: 'Nebula\\QuickBurner', exe: 'QuickBurner', broken: true },
  { n: 'Legacy VPN Client 3.2', p: 'Northwind Networks', mb: 44, x86: true, v: '3.2.1', dir: 'Northwind\\VPN Client', exe: 'nwvpn', noCmd: true },
  { n: 'Driver Booster Trial', p: 'Contoso Utilities', mb: 56, cu: true, v: '9.0.2', dir: 'Contoso\\DriverBooster', exe: 'DriverBooster', broken: true },
  { n: 'Fabrikam Toolbar 1.0', p: 'Fabrikam, Inc.', mb: 3, x86: true, v: '1.0.0.4', dir: 'Fabrikam\\Toolbar', exe: 'fbtoolbar', noCmd: true },
];

const GAMES: { n: string; p: string; gb: number; id: number }[] = [
  { n: 'Counter-Strike 2', p: 'Valve', gb: 34, id: 730 },
  { n: 'Dota 2', p: 'Valve', gb: 41, id: 570 },
  { n: 'Stardew Valley', p: 'ConcernedApe', gb: 0.6, id: 413150 },
  { n: "Baldur's Gate 3", p: 'Larian Studios', gb: 122, id: 1086940 },
  { n: 'ELDEN RING', p: 'FromSoftware Inc.', gb: 60, id: 1245620 },
  { n: 'Terraria', p: 'Re-Logic', gb: 0.7, id: 105600 },
  { n: 'Cyberpunk 2077', p: 'CD PROJEKT RED', gb: 70, id: 1091500 },
  { n: 'Hollow Knight', p: 'Team Cherry', gb: 9, id: 367520 },
  { n: 'Factorio', p: 'Wube Software LTD.', gb: 3, id: 427520 },
  { n: 'Satisfactory', p: 'Coffee Stain Studios', gb: 15, id: 526870 },
  { n: 'Valheim', p: 'Iron Gate AB', gb: 1, id: 892970 },
  { n: 'Black Myth: Wukong', p: 'Game Science', gb: 130, id: 2358720 },
  { n: 'Palworld', p: 'Pocketpair', gb: 40, id: 1623730 },
  { n: 'Deep Rock Galactic', p: 'Ghost Ship Games', gb: 4, id: 548430 },
  { n: 'Portal 2', p: 'Valve', gb: 12, id: 620 },
  { n: 'Hades II', p: 'Supergiant Games', gb: 10, id: 1145350 },
];

const STORE: { n: string; pkg: string; p: string; mb: number; v: string }[] = [
  { n: 'Windows Calculator', pkg: 'Microsoft.WindowsCalculator', p: 'Microsoft Corporation', mb: 32, v: '11.2403.6.0' },
  { n: 'Windows Terminal', pkg: 'Microsoft.WindowsTerminal', p: 'Microsoft Corporation', mb: 110, v: '1.20.11271.0' },
  { n: 'Paint', pkg: 'Microsoft.Paint', p: 'Microsoft Corporation', mb: 28, v: '11.2404.1020.0' },
  { n: 'Snipping Tool', pkg: 'Microsoft.ScreenSketch', p: 'Microsoft Corporation', mb: 45, v: '11.2404.37.0' },
  { n: 'Notepad', pkg: 'Microsoft.WindowsNotepad', p: 'Microsoft Corporation', mb: 24, v: '11.2404.10.0' },
  { n: 'Microsoft To Do', pkg: 'Microsoft.Todos', p: 'Microsoft Corporation', mb: 60, v: '2.120.3662.0' },
  { n: 'Sticky Notes', pkg: 'Microsoft.MicrosoftStickyNotes', p: 'Microsoft Corporation', mb: 30, v: '6.1.1.0' },
  { n: 'Xbox', pkg: 'Microsoft.GamingApp', p: 'Microsoft Corporation', mb: 180, v: '2405.1001.5.0' },
  { n: 'Media Player', pkg: 'Microsoft.ZuneMusic', p: 'Microsoft Corporation', mb: 70, v: '11.2404.7.0' },
  { n: 'Photos', pkg: 'Microsoft.Windows.Photos', p: 'Microsoft Corporation', mb: 120, v: '2024.11050.3002.0' },
  { n: 'Spotify Music', pkg: 'SpotifyAB.SpotifyMusic', p: 'Spotify AB', mb: 300, v: '1.237.603.0' },
  { n: 'Clipchamp', pkg: 'Clipchamp.Clipchamp', p: 'Microsoft Corp.', mb: 160, v: '3.0.10380.0' },
  { n: 'Power Automate', pkg: 'Microsoft.PowerAutomateDesktop', p: 'Microsoft Corporation', mb: 20, v: '11.2404.90.0' },
  { n: 'Microsoft Store', pkg: 'Microsoft.WindowsStore', p: 'Microsoft Corporation', mb: 55, v: '22405.1401.4.0' },
  { n: 'Get Help', pkg: 'Microsoft.GetHelp', p: 'Microsoft Corporation', mb: 12, v: '10.2403.20861.0' },
  { n: 'MSN Weather', pkg: 'Microsoft.BingWeather', p: 'Microsoft Corporation', mb: 40, v: '4.53.52331.0' },
  { n: 'Outlook for Windows', pkg: 'Microsoft.OutlookForWindows', p: 'Microsoft Corporation', mb: 90, v: '1.2024.509.100' },
  { n: 'Feedback Hub', pkg: 'Microsoft.WindowsFeedbackHub', p: 'Microsoft Corporation', mb: 35, v: '1.2404.11052.0' },
  { n: 'Microsoft Whiteboard', pkg: 'Microsoft.Whiteboard', p: 'Microsoft Corporation', mb: 75, v: '54.21201.628.0' },
  { n: 'Intel® Graphics Command Center', pkg: 'AppUp.IntelGraphicsExperience', p: 'INTEL CORP', mb: 65, v: '1.100.5445.0' },
  { n: 'Realtek Audio Console', pkg: 'RealtekSemiconductorCorp.RealtekAudioControl', p: 'Realtek Semiconductor Corp.', mb: 20, v: '1.39.290.0' },
  { n: 'Ubuntu 24.04 LTS', pkg: 'CanonicalGroupLimited.Ubuntu24.04LTS', p: 'Canonical Group Limited', mb: 640, v: '2404.0.5.0' },
  { n: 'Sysinternals Suite', pkg: 'Microsoft.SysinternalsSuite', p: 'Microsoft Corporation', mb: 85, v: '2024.5.1.0' },
  { n: 'Dev Home', pkg: 'Microsoft.Windows.DevHome', p: 'Microsoft Corporation', mb: 130, v: '0.1400.389.0' },
  { n: 'Phone Link', pkg: 'Microsoft.YourPhone', p: 'Microsoft Corporation', mb: 95, v: '1.24042.142.0' },
  { n: 'Quick Assist', pkg: 'MicrosoftCorporationII.QuickAssist', p: 'Microsoft Corporation', mb: 15, v: '2.0.30.0' },
];

/* ------------------------------------------------------------------ */

function guid(rng: () => number): string {
  const hex = () => Math.floor(rng() * 16).toString(16).toUpperCase();
  const seg = (n: number) => Array.from({ length: n }, hex).join('');
  return `{${seg(8)}-${seg(4)}-${seg(4)}-${seg(4)}-${seg(12)}}`;
}

function randDate(rng: () => number, from = Date.UTC(2021, 2, 1)): string {
  // Bias towards recent dates.
  const span = Date.now() - from;
  const r = Math.pow(rng(), 0.6);
  const d = new Date(from + span * r);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function randVersion(rng: () => number): string {
  const a = Math.floor(rng() * 12) + 1;
  const b = Math.floor(rng() * 20);
  const c = Math.floor(rng() * 9000);
  return rng() > 0.5 ? `${a}.${b}.${c}` : `${a}.${b}.${c}.${Math.floor(rng() * 100)}`;
}

function sanitizeFolder(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '').replace(/\s+\(.*?\)/g, '').trim();
}

export interface MockApp extends InstalledApp {
  /** Preview-only hint: uninstaller is missing on disk. */
  broken?: boolean;
}

function fromSeed(seed: Seed, rng: () => number): MockApp {
  const hive = seed.cu ? 'HKCU' : 'HKLM';
  const view = seed.x86 ? 'x86' : 'x64';
  const base = hive === 'HKCU' ? HKCU : view === 'x86' ? HKLM32 : HKLM64;
  const productCode = seed.msi ? guid(rng) : undefined;
  const keyName = productCode ?? seed.n;
  const registryPath = `${base}\\${keyName}`;
  const folder = seed.dir ?? sanitizeFolder(seed.n);
  const installLocation = seed.cu
    ? `${USER_PROFILE}\\AppData\\Local\\Programs\\${folder}`
    : view === 'x86'
      ? `C:\\Program Files (x86)\\${folder}`
      : `C:\\Program Files\\${folder}`;
  const exe = `${installLocation}\\${seed.exe ?? sanitizeFolder(seed.n)}.exe`;

  let uninstallString: string | undefined;
  let quiet: string | undefined;
  if (!seed.noCmd) {
    if (productCode) {
      uninstallString = `MsiExec.exe /${rng() > 0.5 ? 'X' : 'I'}${productCode}`;
      quiet = seed.q || rng() > 0.6 ? `MsiExec.exe /X${productCode} /qn /norestart` : undefined;
    } else if (seed.broken) {
      uninstallString = `"C:\\Program Files\\${folder}\\unins000.exe"`;
    } else {
      const style = rng();
      uninstallString =
        style < 0.4
          ? `"${installLocation}\\uninstall.exe"`
          : style < 0.7
            ? `"${installLocation}\\unins000.exe"`
            : `"${installLocation}\\Uninstall ${sanitizeFolder(seed.n)}.exe" /allusers`;
      if (seed.q) quiet = `${uninstallString} /S`;
    }
  }

  const kind: AppKind = seed.sys ? 'system' : productCode ? 'msi' : 'program';
  const sizeKb = Math.round(seed.mb * 1024 * (0.85 + rng() * 0.3));

  return {
    id: fnvHex(registryPath),
    name: seed.n,
    version: seed.v ?? randVersion(rng),
    publisher: seed.p,
    installDate: randDate(rng),
    estimatedSizeKb: sizeKb,
    installLocation,
    uninstallString,
    quietUninstallString: quiet,
    displayIcon: `${exe},0`,
    registryPath,
    hive,
    registryView: view,
    architecture: view === 'x86' ? 'x86' : 'x64',
    kind,
    isMsi: !!productCode,
    isSystemComponent: !!seed.sys,
    isUpdate: false,
    msiProductCode: productCode,
    helpLink: seed.help,
    aboutUrl: rng() > 0.5 ? `https://www.${seed.p.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'vendor'}.com/` : undefined,
    updateInfoUrl: undefined,
    source: productCode ? 'msi' : 'registry',
    broken: seed.broken,
  };
}

function systemSeeds(rng: () => number): MockApp[] {
  const out: MockApp[] = [];
  const push = (n: string, p: string, mb: number, opts: Partial<Seed> = {}) =>
    out.push(fromSeed({ n, p, mb, msi: true, ...opts }, rng));

  const ms = 'Microsoft Corporation';
  // Visual C++ redistributables (visible) + their runtime sub-packages (system components)
  const vc: [string, string, boolean][] = [
    ['2015-2022', '14.40.33810', false],
    ['2015-2022', '14.40.33810', true],
    ['2013', '12.0.40664', false],
    ['2013', '12.0.40664', true],
    ['2012', '11.0.61030', false],
    ['2012', '11.0.61030', true],
    ['2010', '10.0.40219', false],
    ['2010', '10.0.40219', true],
    ['2008', '9.0.30729.6161', false],
    ['2008', '9.0.30729.6161', true],
  ];
  for (const [year, ver, x86] of vc) {
    push(`Microsoft Visual C++ ${year} Redistributable (${x86 ? 'x86' : 'x64'}) - ${ver}`, ms, 20, { v: ver, x86, dir: 'Common Files\\Microsoft Shared\\VC' });
  }
  for (const arch of ['X64', 'X86']) {
    for (const part of ['Minimum', 'Additional']) {
      push(`Microsoft Visual C++ 2022 ${arch} ${part} Runtime - 14.40.33810`, ms, 14, { v: '14.40.33810', x86: arch === 'X86', sys: true });
      push(`Microsoft Visual C++ 2019 ${arch} ${part} Runtime - 14.29.30153`, ms, 14, { v: '14.29.30153', x86: arch === 'X86', sys: true });
    }
  }
  // .NET
  const dotnet = ['6.0.30', '7.0.19', '8.0.5', '8.0.6'];
  const kinds: [string, boolean][] = [
    ['Microsoft .NET Runtime - {v} ({a})', false],
    ['Microsoft Windows Desktop Runtime - {v} ({a})', false],
    ['Microsoft ASP.NET Core {v} Shared Framework ({a})', false],
    ['Microsoft .NET Host - {v} ({a})', true],
    ['Microsoft .NET Host FX Resolver - {v} ({a})', true],
    ['Microsoft .NET Targeting Pack - {v} ({a})', true],
    ['Microsoft .NET AppHost Pack - {v} ({a})', true],
    ['Microsoft .NET Templates {v} ({a})', true],
  ];
  for (const v of dotnet) {
    for (const [tpl, sys] of kinds) {
      push(tpl.replace('{v}', v).replace('{a}', 'x64'), ms, sys ? 3 : 70, { v, sys, dir: 'dotnet' });
      if (!sys && tpl.includes('Runtime')) push(tpl.replace('{v}', v).replace('{a}', 'x86'), ms, 60, { v, x86: true, dir: 'dotnet' });
    }
  }
  push('Microsoft .NET SDK 8.0.300 (x64)', ms, 900, { v: '8.0.300', dir: 'dotnet' });
  push('Microsoft .NET Framework 4.8.1 SDK', ms, 240, { v: '4.8.09032', x86: true, dir: 'Microsoft SDKs\\Windows\\v10.0A' });
  // Windows SDK pieces
  const sdkParts = [
    'Windows SDK AddOn', 'Windows SDK Desktop Headers x64', 'Windows SDK Desktop Headers x86', 'Windows SDK Desktop Headers arm64',
    'Windows SDK Desktop Libs x64', 'Windows SDK Desktop Libs x86', 'Windows SDK Desktop Libs arm64', 'Windows SDK Desktop Tools x64',
    'Windows SDK Desktop Tools x86', 'Windows SDK for Windows Store Apps', 'Windows SDK for Windows Store Apps Headers',
    'Windows SDK for Windows Store Apps Libs', 'Windows SDK for Windows Store Apps Tools', 'Windows SDK Signing Tools',
    'Windows SDK Modern Versioned Developer Tools', 'Windows SDK Modern Non-Versioned Developer Tools', 'Windows SDK Facade Windows WinMD Versioned',
    'Windows SDK EULA', 'Windows SDK Redistributables', 'Windows SDK DirectX x64 Remote', 'Windows SDK DirectX x86 Remote',
    'Windows SDK ARM Desktop Tools', 'Windows App Certification Kit Native Components', 'Windows App Certification Kit x64',
  ];
  for (const build of ['10.0.22621.3233', '10.0.26100.1']) {
    for (const part of sdkParts) push(`${part}`, ms, 18, { v: build, sys: true, x86: true, dir: 'Windows Kits\\10' });
    push(`Windows Software Development Kit - Windows 10.0.${build.split('.')[2]}`, ms, 2600, { v: build, x86: true, dir: 'Windows Kits\\10' });
  }
  // Python components
  for (const part of ['Core Interpreter', 'Executables', 'Standard Library', 'Development Libraries', 'Tcl/Tk Support', 'Documentation', 'Utility Scripts', 'pip Bootstrap', 'Test Suite', 'Add to Path']) {
    push(`Python 3.12.3 ${part} (64-bit)`, 'Python Software Foundation', 12, { v: '3.12.3150.0', sys: true, cu: true, dir: 'Python\\Python312' });
  }
  push('Python Launcher', 'Python Software Foundation', 2, { v: '3.12.3150.0', x86: true, dir: 'Python\\Launcher' });
  // Office / VS / drivers
  for (const part of ['Office 16 Click-to-Run Extensibility Component', 'Office 16 Click-to-Run Licensing Component', 'Office 16 Click-to-Run Localization Component', 'Microsoft OneNote - zh-cn', 'Microsoft Office 专业增强版 2021 - zh-cn', 'Microsoft Visio - zh-cn', 'Teams Machine-Wide Installer', 'Microsoft Update Health Tools']) {
    push(part, ms, 30, { sys: !part.includes('zh-cn'), x86: true, dir: 'Microsoft Office\\root' });
  }
  for (const part of ['Microsoft Visual Studio Installer', 'Microsoft Visual Studio Setup WMI Provider', 'vs_CoreEditorFonts', 'vs_FileTracker_Singleton', 'vs_minshellinteropx64msi', 'vs_devenvsharedmsi', 'vs_clickoncebootstrappermsi', 'vs_communitymsires', 'vs_tipsmsi', 'Microsoft Visual Studio 2022 Language Pack - zh-cn', 'IntelliTraceProfilerProxy', 'Microsoft TestPlatform SDK Local Feed']) {
    push(part, ms, 25, { sys: true, x86: true, dir: 'Microsoft Visual Studio\\2022' });
  }
  for (const part of ['Intel(R) Chipset Device Software', 'Intel(R) Management Engine Components', 'Intel(R) Serial IO', 'Intel(R) Wireless Bluetooth(R)', 'Intel(R) Rapid Storage Technology', 'Intel(R) Processor Graphics', 'Intel(R) Computing Improvement Program']) {
    push(part, 'Intel Corporation', 60, { msi: false, dir: 'Intel' });
  }
  for (const part of ['NVIDIA FrameView SDK 1.4.10624', 'NVIDIA HD Audio Driver 1.4.1.2', 'NVIDIA USBC Driver 1.56.1012', 'NVIDIA Install Application', 'NVIDIA Container']) {
    push(part, 'NVIDIA Corporation', 40, { msi: false, sys: part.includes('Application') || part.includes('Container'), dir: 'NVIDIA Corporation' });
  }
  push('Microsoft GameInput', ms, 9, { x86: true });
  push('Windows PC Health Check', ms, 14, {});
  push('Microsoft Visual Studio Tools for Applications 2019', ms, 300, { x86: true });
  push('Microsoft Edge WebView2 Runtime Update', ms, 2, { sys: true, x86: true });
  push('Windows Subsystem for Linux Update', ms, 60, { x86: true });
  return out;
}

function updateSeeds(rng: () => number): MockApp[] {
  const out: MockApp[] = [];
  const ms = 'Microsoft Corporation';
  const officeKbs = [5002537, 5002549, 5002552, 5002574, 5002587, 5002601, 5002604, 5002610, 5002621, 5002632, 5002638, 5002641, 5002655, 5002667, 5002678, 5002690, 5002701, 5002713, 5002726, 5002738];
  const officeProducts = ['Microsoft Office 2016', 'Microsoft Excel 2016', 'Microsoft Word 2016', 'Microsoft Outlook 2016', 'Microsoft PowerPoint 2016', 'Microsoft Project 2016'];
  const parentCode = '{90160000-0011-0000-0000-0000000FF1CE}';
  officeKbs.forEach((kb, i) => {
    const product = officeProducts[i % officeProducts.length];
    const patch = guid(rng);
    const name = `Security Update for ${product} (KB${kb}) 32-Bit Edition`;
    const registryPath = `${HKLM32}\\${parentCode}_Office16.PROPLUS_${patch}`;
    out.push({
      id: fnvHex(registryPath),
      name,
      version: undefined,
      publisher: ms,
      installDate: randDate(rng, Date.UTC(2023, 0, 1)),
      estimatedSizeKb: undefined,
      installLocation: undefined,
      uninstallString: `"C:\\Program Files\\Common Files\\Microsoft Shared\\OFFICE16\\Oarpmany.exe" /removereleaseinpatch "${parentCode}" "${patch}" "1033" "0"`,
      quietUninstallString: undefined,
      displayIcon: undefined,
      registryPath,
      hive: 'HKLM',
      registryView: 'x86',
      architecture: 'x86',
      kind: 'update',
      isMsi: true,
      isSystemComponent: false,
      isUpdate: true,
      msiProductCode: parentCode,
      helpLink: `https://support.microsoft.com/kb/${kb}`,
      source: 'msi',
    });
  });
  const vsKbs = [5027181, 5030512, 5033213, 5034862, 5035818, 5036576, 5037033, 5038094];
  for (const kb of vsKbs) {
    const registryPath = `${HKLM32}\\KB${kb}`;
    out.push({
      id: fnvHex(registryPath),
      name: `Update for Microsoft Visual Studio 2022 (KB${kb})`,
      version: undefined,
      publisher: ms,
      installDate: randDate(rng, Date.UTC(2023, 5, 1)),
      estimatedSizeKb: 1024 * (10 + Math.floor(rng() * 60)),
      installLocation: undefined,
      uninstallString: `"C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\setup.exe" uninstall --update KB${kb}`,
      quietUninstallString: `"C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\setup.exe" uninstall --update KB${kb} --quiet`,
      displayIcon: undefined,
      registryPath,
      hive: 'HKLM',
      registryView: 'x86',
      architecture: 'x86',
      kind: 'update',
      isMsi: false,
      isSystemComponent: false,
      isUpdate: true,
      helpLink: `https://support.microsoft.com/kb/${kb}`,
      source: 'registry',
    });
  }
  const winKbs = [4023057, 5001716, 5011048, 5026038, 5031239, 5034123, 5036980, 5037771];
  for (const kb of winKbs) {
    const registryPath = `${HKLM64}\\KB${kb}`;
    out.push({
      id: fnvHex(registryPath),
      name: `Update for Windows 11 for x64-based Systems (KB${kb})`,
      version: '1.0',
      publisher: ms,
      installDate: randDate(rng, Date.UTC(2022, 0, 1)),
      estimatedSizeKb: 1024 * (2 + Math.floor(rng() * 20)),
      installLocation: undefined,
      uninstallString: `C:\\Windows\\System32\\wusa.exe /uninstall /kb:${kb}`,
      quietUninstallString: `C:\\Windows\\System32\\wusa.exe /uninstall /kb:${kb} /quiet /norestart`,
      displayIcon: undefined,
      registryPath,
      hive: 'HKLM',
      registryView: 'x64',
      architecture: 'x64',
      kind: 'update',
      isMsi: false,
      isSystemComponent: false,
      isUpdate: true,
      source: 'registry',
    });
  }
  return out;
}

function gameSeeds(rng: () => number): MockApp[] {
  return GAMES.map((g) => {
    const registryPath = `${HKLM32}\\Steam App ${g.id}`;
    const installLocation = `D:\\SteamLibrary\\steamapps\\common\\${g.n.replace(/[:']/g, '')}`;
    return {
      id: fnvHex(registryPath),
      name: g.n,
      version: undefined,
      publisher: g.p,
      installDate: randDate(rng, Date.UTC(2022, 6, 1)),
      estimatedSizeKb: Math.round(g.gb * 1024 * 1024 * (0.9 + rng() * 0.2)),
      installLocation,
      uninstallString: `"C:\\Program Files (x86)\\Steam\\steam.exe" steam://uninstall/${g.id}`,
      quietUninstallString: undefined,
      displayIcon: `C:\\Program Files (x86)\\Steam\\steam\\games\\${fnvHex(g.n)}.ico`,
      registryPath,
      hive: 'HKLM' as const,
      registryView: 'x86' as const,
      architecture: 'x64' as Architecture,
      kind: 'game' as AppKind,
      isMsi: false,
      isSystemComponent: false,
      isUpdate: false,
      helpLink: `https://store.steampowered.com/app/${g.id}`,
      source: 'steam' as const,
    };
  });
}

function storeSeeds(rng: () => number): MockApp[] {
  return STORE.map((s) => {
    const publisherId = s.pkg.startsWith('Microsoft') ? '8wekyb3d8bbwe' : fnvHex(s.p).slice(0, 13).padEnd(13, 'a');
    const full = `${s.pkg}_${s.v}_x64__${publisherId}`;
    const registryPath = `HKCU\\SOFTWARE\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages\\${full}`;
    return {
      id: fnvHex(registryPath),
      name: s.n,
      version: s.v,
      publisher: s.p,
      installDate: randDate(rng, Date.UTC(2023, 0, 1)),
      estimatedSizeKb: Math.round(s.mb * 1024 * (0.9 + rng() * 0.2)),
      installLocation: `C:\\Program Files\\WindowsApps\\${full}`,
      uninstallString: `powershell.exe -NoProfile -Command "Get-AppxPackage ${s.pkg} | Remove-AppxPackage"`,
      quietUninstallString: `powershell.exe -NoProfile -NonInteractive -Command "Get-AppxPackage ${s.pkg} | Remove-AppxPackage"`,
      displayIcon: `C:\\Program Files\\WindowsApps\\${full}\\Assets\\AppIcon.png`,
      registryPath,
      hive: 'HKCU' as const,
      registryView: 'x64' as const,
      architecture: 'x64' as Architecture,
      kind: 'store' as AppKind,
      isMsi: false,
      isSystemComponent: false,
      isUpdate: false,
      packageFullName: full,
      aboutUrl: `ms-windows-store://pdp/?PFN=${s.pkg}_${publisherId}`,
      source: 'store' as const,
    };
  });
}

export function generateMockApps(seed = 20240601): MockApp[] {
  const rng = mulberry32(seed);
  const all: MockApp[] = [
    ...PROGRAMS.map((s) => fromSeed(s, rng)),
    ...gameSeeds(rng),
    ...storeSeeds(rng),
    ...systemSeeds(rng),
    ...updateSeeds(rng),
  ];
  // Ensure ids are unique even if two paths collide.
  const seen = new Set<string>();
  for (const app of all) {
    let id = app.id;
    let i = 1;
    while (seen.has(id)) id = `${app.id}-${i++}`;
    app.id = id;
    seen.add(id);
  }
  return all;
}

/** A tiny deterministic SVG "icon" used to stand in for extracted .exe icons. */
export function makeSvgIcon(name: string, color: string): string {
  const letter = (name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${color}" stop-opacity="0.65"/></linearGradient></defs><rect width="32" height="32" rx="7" fill="url(#g)"/><text x="16" y="21.5" font-family="Segoe UI, Arial, sans-serif" font-size="16" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
