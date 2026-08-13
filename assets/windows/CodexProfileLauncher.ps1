param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$CliPath,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [switch]$StartHidden,
    [string]$PreviewPath = ""
)

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Xaml
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CodexProfileNative {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
}
"@

try { [void][CodexProfileNative]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch {}

$isPreview = -not [string]::IsNullOrWhiteSpace($PreviewPath)
$instanceName = if ($isPreview) { "Local\CodexProfileWpfV3Preview-$PID" } else { "Local\CodexProfileWpfV3Launcher" }
$createdNew = $false
$instanceMutex = New-Object System.Threading.Mutex($true, $instanceName, [ref]$createdNew)
if (-not $createdNew) {
    if (-not $StartHidden) {
        try {
            $existingEvent = [System.Threading.EventWaitHandle]::OpenExisting("Local\CodexProfileWpfV3Show")
            [void]$existingEvent.Set()
            $existingEvent.Dispose()
        } catch {}
    }
    $instanceMutex.Dispose()
    exit
}
$showEventName = if ($isPreview) { "Local\CodexProfileWpfV3PreviewShow-$PID" } else { "Local\CodexProfileWpfV3Show" }
$showEvent = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, $showEventName)

function Get-CodexResource([string]$name) {
    try {
        $package = Get-AppxPackage OpenAI.Codex -ErrorAction Stop | Select-Object -First 1
        $candidate = Join-Path $package.InstallLocation ("app\resources\" + $name)
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    } catch {}
    return $null
}

$script:CodexBlackIcon = Get-CodexResource "chatgpt-tray-light.ico"
$script:CodexWhiteIcon = Get-CodexResource "chatgpt-tray-dark.ico"
$script:CodexAppIcon = Get-CodexResource "chatgpt-tray-dark.ico"

[xml]$mainXaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Codex Profile" Width="690" Height="350"
        WindowStyle="None" ResizeMode="NoResize" AllowsTransparency="False"
        Background="#202123" ShowInTaskbar="True" UseLayoutRounding="True"
        SnapsToDevicePixels="True" TextOptions.TextFormattingMode="Display"
        TextOptions.TextRenderingMode="ClearType" RenderOptions.ClearTypeHint="Enabled"
        FontFamily="Segoe UI Variable Text" WindowStartupLocation="CenterScreen">
  <Window.Resources>
    <Style x:Key="WindowButton" TargetType="Button">
      <Setter Property="Width" Value="38"/><Setter Property="Height" Value="34"/>
      <Setter Property="Background" Value="Transparent"/><Setter Property="BorderThickness" Value="0"/>
      <Setter Property="Foreground" Value="#A6A6A8"/><Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="Surface" Background="{TemplateBinding Background}" CornerRadius="9">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Surface" Property="Background" Value="#303033"/><Setter Property="Foreground" Value="#FFFFFF"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="RoundButton" TargetType="Button">
      <Setter Property="Width" Value="38"/><Setter Property="Height" Value="38"/>
      <Setter Property="Background" Value="#292A2D"/><Setter Property="BorderBrush" Value="#3B3C3F"/>
      <Setter Property="BorderThickness" Value="1"/><Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="Surface" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="11">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Surface" Property="Background" Value="#343538"/><Setter TargetName="Surface" Property="BorderBrush" Value="#626267"/></Trigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="Surface" Property="Background" Value="#3B3C3F"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <Grid Background="#202123">
    <Grid.RowDefinitions><RowDefinition Height="48"/><RowDefinition Height="*"/></Grid.RowDefinitions>
    <Border Grid.Row="0" BorderBrush="#343538" BorderThickness="0,0,0,1" Background="#202123">
      <Grid x:Name="TitleBar">
        <StackPanel Orientation="Horizontal" Margin="18,0,0,0" VerticalAlignment="Center">
          <Image x:Name="HeaderLogo" Width="23" Height="23" Stretch="Uniform" RenderOptions.BitmapScalingMode="Fant"/>
          <TextBlock Text="Codex Profile" Margin="10,0,0,1" VerticalAlignment="Center" Foreground="#F3F3F4" FontFamily="Segoe UI Variable Display" FontSize="15" FontWeight="SemiBold"/>
        </StackPanel>
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,0,7,0" VerticalAlignment="Center">
          <Button x:Name="MinimizeButton" Style="{StaticResource WindowButton}">
            <Path Width="13" Height="1" Stretch="Fill" Stroke="{Binding Foreground, RelativeSource={RelativeSource AncestorType=Button}}" StrokeThickness="1.4" Data="M 0,0.5 L 13,0.5"/>
          </Button>
          <Button x:Name="CloseButton" Style="{StaticResource WindowButton}">
            <Grid Width="14" Height="14"><Path Stroke="{Binding Foreground, RelativeSource={RelativeSource AncestorType=Button}}" StrokeThickness="1.35" Data="M 1,1 L 13,13 M 13,1 L 1,13"/></Grid>
          </Button>
        </StackPanel>
      </Grid>
    </Border>
    <Grid Grid.Row="1" Margin="26,18,26,14">
      <Grid.RowDefinitions><RowDefinition Height="62"/><RowDefinition Height="*"/><RowDefinition Height="26"/></Grid.RowDefinitions>
      <Grid Grid.Row="0">
        <StackPanel VerticalAlignment="Top">
          <TextBlock Text="Choose a profile" Foreground="#F5F5F6" FontFamily="Segoe UI Variable Display" FontSize="25" FontWeight="SemiBold"/>
          <TextBlock Text="Switch between your Codex accounts" Margin="0,5,0,0" Foreground="#A3A3A6" FontSize="12.5"/>
        </StackPanel>
        <Button x:Name="RefreshButton" Style="{StaticResource RoundButton}" HorizontalAlignment="Right" VerticalAlignment="Top">
          <Grid Width="18" Height="18">
            <Viewbox Width="18" Height="18" HorizontalAlignment="Center" VerticalAlignment="Center">
              <Path Width="24" Height="24" Stretch="Uniform" Stroke="#ECECEE" StrokeThickness="1.65" StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round" Data="M 20,11 A 8,8 0 1 0 18.2,17 M 20,5 L 20,11 L 14,11"/>
            </Viewbox>
          </Grid>
        </Button>
      </Grid>
      <ScrollViewer x:Name="ProfilesScroller" Grid.Row="1" HorizontalScrollBarVisibility="Hidden" VerticalScrollBarVisibility="Disabled" PanningMode="HorizontalOnly" Focusable="False">
        <StackPanel x:Name="ProfilesHost" Orientation="Horizontal" HorizontalAlignment="Left" VerticalAlignment="Center" Margin="0,2,0,4"/>
      </ScrollViewer>
      <Grid Grid.Row="2">
        <TextBlock x:Name="StatusText" Foreground="#A3A3A6" FontSize="11.5" VerticalAlignment="Center" TextTrimming="CharacterEllipsis"/>
        <ProgressBar x:Name="OperationProgress" Width="110" Height="2" HorizontalAlignment="Right" VerticalAlignment="Center" IsIndeterminate="True" Visibility="Collapsed" Foreground="#E8E8EA" Background="#3A3A3D" BorderThickness="0"/>
      </Grid>
    </Grid>
  </Grid>
</Window>
"@

[xml]$dockXaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Width="54" Height="54" WindowStyle="None" ResizeMode="NoResize"
        AllowsTransparency="True" Background="Transparent" ShowInTaskbar="False"
        Topmost="True" UseLayoutRounding="True" SnapsToDevicePixels="True">
  <Border x:Name="DockSurface" CornerRadius="27" Background="#232322" BorderBrush="#4C4C49" BorderThickness="1" Cursor="Hand">
    <Grid>
      <Ellipse x:Name="DockHover" Margin="3" Fill="#FFFFFF" Opacity="0"/>
      <Image x:Name="DockLogo" Width="31" Height="31" Stretch="Uniform" RenderOptions.BitmapScalingMode="Fant"/>
    </Grid>
  </Border>
</Window>
"@

function Load-Xaml([xml]$xaml) {
    $reader = New-Object System.Xml.XmlNodeReader($xaml)
    return [Windows.Markup.XamlReader]::Load($reader)
}

function New-BitmapSource([string]$path) {
    if (-not $path -or -not (Test-Path -LiteralPath $path)) { return $null }
    try {
        $image = New-Object Windows.Media.Imaging.BitmapImage
        $image.BeginInit()
        $image.CacheOption = [Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        $image.CreateOptions = [Windows.Media.Imaging.BitmapCreateOptions]::IgnoreImageCache
        $image.UriSource = New-Object System.Uri($path, [System.UriKind]::Absolute)
        $image.EndInit()
        $image.Freeze()
        return $image
    } catch { return $null }
}

function New-SolidBrush([string]$color) {
    return New-Object Windows.Media.SolidColorBrush([Windows.Media.ColorConverter]::ConvertFromString($color))
}

function New-Text([string]$text, [double]$size, [string]$color, [string]$family = "Segoe UI Variable Text", [string]$weight = "Normal") {
    $block = New-Object Windows.Controls.TextBlock
    $block.Text = $text
    $block.FontSize = $size
    $block.Foreground = New-SolidBrush $color
    $block.FontFamily = New-Object Windows.Media.FontFamily($family)
    $block.FontWeight = [Windows.FontWeights]::$weight
    $block.TextAlignment = [Windows.TextAlignment]::Center
    $block.HorizontalAlignment = [Windows.HorizontalAlignment]::Center
    $block.TextTrimming = [Windows.TextTrimming]::CharacterEllipsis
    return $block
}

function New-Pill([string]$text, [string]$background, [string]$foreground) {
    $pill = New-Object Windows.Controls.Border
    $pill.Height = 25
    $pill.MinWidth = 68
    $pill.Padding = New-Object Windows.Thickness(12, 0, 12, 0)
    $pill.CornerRadius = New-Object Windows.CornerRadius(13)
    $pill.Background = New-SolidBrush $background
    $pill.HorizontalAlignment = [Windows.HorizontalAlignment]::Center
    $label = New-Text $text 10.5 $foreground "Segoe UI Variable Text" "Normal"
    $label.VerticalAlignment = [Windows.VerticalAlignment]::Center
    $pill.Child = $label
    return $pill
}

function Set-AvatarContent($container, $profile, [double]$size) {
    $grid = New-Object Windows.Controls.Grid
    $source = New-BitmapSource $profile.avatar
    $ellipse = New-Object Windows.Shapes.Ellipse
    $ellipse.Width = $size
    $ellipse.Height = $size
    if ($source) {
        $brush = New-Object Windows.Media.ImageBrush($source)
        $brush.Stretch = [Windows.Media.Stretch]::UniformToFill
        $brush.AlignmentX = [Windows.Media.AlignmentX]::Center
        $brush.AlignmentY = [Windows.Media.AlignmentY]::Center
        $ellipse.Fill = $brush
        [Windows.Media.RenderOptions]::SetBitmapScalingMode($ellipse, [Windows.Media.BitmapScalingMode]::Fant)
    } else {
        $ellipse.Fill = New-SolidBrush "#E4E4E0"
    }
    [void]$grid.Children.Add($ellipse)
    if (-not $source) {
        $initial = New-Text $(if ($profile.label) { $profile.label.Substring(0, 1).ToUpperInvariant() } else { "?" }) ($size * 0.38) "#51514E" "Segoe UI Variable Display" "SemiBold"
        $initial.VerticalAlignment = [Windows.VerticalAlignment]::Center
        [void]$grid.Children.Add($initial)
    }
    $container.Child = $grid
}

function New-CheckBadge {
    $badge = New-Object Windows.Controls.Border
    $badge.Width = 28; $badge.Height = 28
    $badge.CornerRadius = New-Object Windows.CornerRadius(14)
    $badge.Background = New-SolidBrush "#ECECEE"
    $badge.HorizontalAlignment = [Windows.HorizontalAlignment]::Right
    $badge.VerticalAlignment = [Windows.VerticalAlignment]::Top
    $badge.Margin = New-Object Windows.Thickness(0, 13, 13, 0)
    $path = New-Object Windows.Shapes.Path
    $path.Data = [Windows.Media.Geometry]::Parse("M 7,12 L 11,16 L 20,7")
    $path.Stroke = New-SolidBrush "#202123"
    $path.StrokeThickness = 2.2
    $path.StrokeStartLineCap = [Windows.Media.PenLineCap]::Round
    $path.StrokeEndLineCap = [Windows.Media.PenLineCap]::Round
    $path.StrokeLineJoin = [Windows.Media.PenLineJoin]::Round
    $path.Width = 22; $path.Height = 20; $path.Stretch = [Windows.Media.Stretch]::Uniform
    $badge.Child = $path
    return $badge
}

$mainWindow = Load-Xaml $mainXaml
$dockWindow = Load-Xaml $dockXaml
$titleBar = $mainWindow.FindName("TitleBar")
$minimizeButton = $mainWindow.FindName("MinimizeButton")
$closeButton = $mainWindow.FindName("CloseButton")
$refreshButton = $mainWindow.FindName("RefreshButton")
$profilesScroller = $mainWindow.FindName("ProfilesScroller")
$profilesHost = $mainWindow.FindName("ProfilesHost")
$statusText = $mainWindow.FindName("StatusText")
$operationProgress = $mainWindow.FindName("OperationProgress")
$headerLogo = $mainWindow.FindName("HeaderLogo")
$dockSurface = $dockWindow.FindName("DockSurface")
$dockHover = $dockWindow.FindName("DockHover")
$dockLogo = $dockWindow.FindName("DockLogo")

$whiteLogo = New-BitmapSource $script:CodexWhiteIcon
if ($whiteLogo) { $headerLogo.Source = $whiteLogo }
if ($whiteLogo) { $dockLogo.Source = $whiteLogo }
if ($script:CodexAppIcon) {
    try { $mainWindow.Icon = New-BitmapSource $script:CodexAppIcon } catch {}
}

$script:Profiles = @()
$script:ActiveProfile = $null
$script:SwitchProcess = $null
$script:AddProcess = $null
$script:ExitRequested = $false
$script:PendingProfile = $null

function Set-OperationState([string]$message, [bool]$busy = $false) {
    $statusText.Text = $message
    $operationProgress.Visibility = if ($busy) { [Windows.Visibility]::Visible } else { [Windows.Visibility]::Collapsed }
}

function Activate-ChromeSoon {
    $activateTimer = New-Object Windows.Threading.DispatcherTimer
    $activateTimer.Interval = [TimeSpan]::FromMilliseconds(900)
    $activateTimer.Tag = $activateTimer
    $activateTimer.Add_Tick({
        param($sender, $eventArgs)
        $sender.Stop()
        try {
            $shell = New-Object -ComObject WScript.Shell
            $chrome = Get-Process -Name chrome -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0 | Sort-Object StartTime -Descending | Select-Object -First 1
            if ($chrome) { [void]$shell.AppActivate($chrome.Id) }
        } catch {}
    })
    $activateTimer.Start()
}

function Start-ProfileSwitch($profile) {
    if ($script:SwitchProcess -and -not $script:SwitchProcess.HasExited) {
        Set-OperationState "A profile change is already in progress." $true
        return
    }
    if ($script:AddProcess -and -not $script:AddProcess.HasExited) {
        Set-OperationState "Finish or cancel the current Add Account sign-in first." $true
        return
    }
    $arguments = @("`"$CliPath`"", "desktop", "use", $profile.id)
    $needsRepair = $profile.status -eq "reauth-required"
    if ($needsRepair) { $arguments += "--repair-login" }
    $script:PendingProfile = $profile
    $script:SwitchProcess = Start-Process -FilePath $NodePath -ArgumentList $arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru
    if ($needsRepair) {
        Set-OperationState "$($profile.label) needs a one-time sign-in repair. Continue in Chrome." $true
        Activate-ChromeSoon
    } else {
        Set-OperationState "Switching to $($profile.label) and relaunching Codex..." $true
        $mainWindow.Hide()
    }
}

function Start-AddAccount {
    if ($script:AddProcess -and -not $script:AddProcess.HasExited) {
        Set-OperationState "Add Account is already waiting for the one-time sign-in in Chrome." $true
        Activate-ChromeSoon
        return
    }
    if ($script:SwitchProcess -and -not $script:SwitchProcess.HasExited) {
        Set-OperationState "Wait for the current profile change to finish." $true
        return
    }
    $script:AddProcess = Start-Process -FilePath $NodePath -ArgumentList @("`"$CliPath`"", "add") -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru
    Set-OperationState "Add Account is ready. Complete the one-time sign-in in Chrome." $true
    Activate-ChromeSoon
}

function Animate-Scale($element, [double]$value, [int]$milliseconds) {
    if (-not ($element.RenderTransform -is [Windows.Media.ScaleTransform])) {
        $element.RenderTransformOrigin = New-Object Windows.Point(0.5, 0.5)
        $element.RenderTransform = New-Object Windows.Media.ScaleTransform(1, 1)
    }
    $ease = New-Object Windows.Media.Animation.CubicEase
    $ease.EasingMode = [Windows.Media.Animation.EasingMode]::EaseOut
    $duration = New-Object Windows.Duration([TimeSpan]::FromMilliseconds($milliseconds))
    $x = New-Object Windows.Media.Animation.DoubleAnimation($value, $duration)
    $y = New-Object Windows.Media.Animation.DoubleAnimation($value, $duration)
    $x.EasingFunction = $ease; $y.EasingFunction = $ease
    $element.RenderTransform.BeginAnimation([Windows.Media.ScaleTransform]::ScaleXProperty, $x)
    $element.RenderTransform.BeginAnimation([Windows.Media.ScaleTransform]::ScaleYProperty, $y)
}

function Add-HoverBehavior($tile, $visual, [bool]$enabled) {
    if (-not $enabled) { return }
    $tile.Cursor = [Windows.Input.Cursors]::Hand
    $tile.Add_MouseEnter({
        param($sender, $eventArgs)
        Animate-Scale $sender.Tag.visual 1.055 170
        $sender.Tag.ring.Opacity = 1
    })
    $tile.Add_MouseLeave({
        param($sender, $eventArgs)
        Animate-Scale $sender.Tag.visual 1 220
        $sender.Tag.ring.Opacity = $(if ($sender.Tag.active) { 1 } else { 0.55 })
    })
}

function New-ProfileCard($profile) {
    $card = New-Object Windows.Controls.Border
    $card.Width = 150; $card.Height = 178
    $card.Margin = New-Object Windows.Thickness(0, 0, 10, 0)
    $card.Background = [Windows.Media.Brushes]::Transparent

    $content = New-Object Windows.Controls.StackPanel
    $content.HorizontalAlignment = [Windows.HorizontalAlignment]::Center
    $content.VerticalAlignment = [Windows.VerticalAlignment]::Center
    $content.Width = 142

    $avatarGrid = New-Object Windows.Controls.Grid
    $avatarGrid.Width = 120; $avatarGrid.Height = 120
    $avatarGrid.HorizontalAlignment = [Windows.HorizontalAlignment]::Center
    $ring = New-Object Windows.Shapes.Ellipse
    $ring.Width = 120; $ring.Height = 120
    $ring.Stroke = New-SolidBrush $(if ($profile.active) { "#F2F2F3" } else { "#77777B" })
    $ring.StrokeThickness = $(if ($profile.active) { 2.2 } else { 1.2 })
    $ring.Opacity = $(if ($profile.active) { 1 } else { 0.55 })
    [void]$avatarGrid.Children.Add($ring)
    $avatar = New-Object Windows.Controls.Border
    $avatar.Width = 112; $avatar.Height = 112
    $avatar.CornerRadius = New-Object Windows.CornerRadius(56)
    $avatar.Background = New-SolidBrush "#35363A"
    $avatar.HorizontalAlignment = [Windows.HorizontalAlignment]::Center
    $avatar.VerticalAlignment = [Windows.VerticalAlignment]::Center
    Set-AvatarContent $avatar $profile 112
    [void]$avatarGrid.Children.Add($avatar)
    if ($profile.active) {
        $badge = New-CheckBadge
        $badge.Width = 25; $badge.Height = 25; $badge.CornerRadius = New-Object Windows.CornerRadius(13)
        $badge.Margin = New-Object Windows.Thickness(0, 1, 1, 0)
        [void]$avatarGrid.Children.Add($badge)
    }
    [void]$content.Children.Add($avatarGrid)

    $label = New-Text $profile.label 14.5 "#F5F5F6" "Segoe UI Variable Display" "SemiBold"
    $label.Margin = New-Object Windows.Thickness(4, 12, 4, 0)
    [void]$content.Children.Add($label)

    $card.Child = $content
    $card.Tag = [pscustomobject]@{ profile = $profile; visual = $avatarGrid; ring = $ring; active = [bool]$profile.active }
    Add-HoverBehavior $card $avatarGrid (-not $profile.active)
    if (-not $profile.active) {
        $card.Add_MouseLeftButtonUp({ param($sender, $eventArgs) Start-ProfileSwitch $sender.Tag.profile })
    }
    return $card
}

function New-AddCard {
    $card = New-Object Windows.Controls.Border
    $card.Width = 150; $card.Height = 178
    $card.Margin = New-Object Windows.Thickness(0, 0, 0, 0)
    $card.Background = [Windows.Media.Brushes]::Transparent

    $content = New-Object Windows.Controls.StackPanel
    $content.HorizontalAlignment = [Windows.HorizontalAlignment]::Center
    $content.VerticalAlignment = [Windows.VerticalAlignment]::Center
    $content.Width = 142

    $circle = New-Object Windows.Controls.Grid
    $circle.Width = 120; $circle.Height = 120
    $ring = New-Object Windows.Shapes.Ellipse
    $ring.Width = 112; $ring.Height = 112
    $ring.Stroke = New-SolidBrush "#68686D"
    $ring.StrokeThickness = 1.5
    $ring.Opacity = 0.68
    $dashPattern = New-Object Windows.Media.DoubleCollection
    [void]$dashPattern.Add(3); [void]$dashPattern.Add(3)
    $ring.StrokeDashArray = $dashPattern
    $horizontal = New-Object Windows.Shapes.Rectangle
    $horizontal.Width = 30; $horizontal.Height = 1.5
    $horizontal.Fill = New-SolidBrush "#B4B4B7"
    $horizontal.HorizontalAlignment = [Windows.HorizontalAlignment]::Center
    $horizontal.VerticalAlignment = [Windows.VerticalAlignment]::Center
    $vertical = New-Object Windows.Shapes.Rectangle
    $vertical.Width = 1.5; $vertical.Height = 30
    $vertical.Fill = New-SolidBrush "#B4B4B7"
    $vertical.HorizontalAlignment = [Windows.HorizontalAlignment]::Center
    $vertical.VerticalAlignment = [Windows.VerticalAlignment]::Center
    [void]$circle.Children.Add($ring); [void]$circle.Children.Add($horizontal); [void]$circle.Children.Add($vertical)
    [void]$content.Children.Add($circle)

    $label = New-Text "Add account" 14.5 "#F5F5F6" "Segoe UI Variable Display" "SemiBold"
    $label.Margin = New-Object Windows.Thickness(4, 12, 4, 0)
    [void]$content.Children.Add($label)

    $card.Child = $content
    $card.Tag = [pscustomobject]@{ visual = $circle; ring = $ring; active = $false }
    Add-HoverBehavior $card $circle $true
    $card.Add_MouseLeftButtonUp({ Start-AddAccount })
    return $card
}

function Rebuild-TrayMenu {
    $trayMenu.Items.Clear()
    foreach ($profile in $script:Profiles) {
        $prefix = if ($profile.active) { "*  " } else { "   " }
        $item = New-Object System.Windows.Forms.ToolStripMenuItem("$prefix$($profile.label)")
        $item.Tag = $profile
        $item.Add_Click({ param($sender, $eventArgs) if (-not $sender.Tag.active) { Start-ProfileSwitch $sender.Tag } })
        [void]$trayMenu.Items.Add($item)
    }
    [void]$trayMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
    $open = New-Object System.Windows.Forms.ToolStripMenuItem("Choose a profile")
    $open.Add_Click({ Show-ProfileWindow }); [void]$trayMenu.Items.Add($open)
    $add = New-Object System.Windows.Forms.ToolStripMenuItem("Add account")
    $add.Add_Click({ Show-ProfileWindow; Start-AddAccount }); [void]$trayMenu.Items.Add($add)
    $exit = New-Object System.Windows.Forms.ToolStripMenuItem("Exit")
    $exit.Add_Click({ Stop-Launcher }); [void]$trayMenu.Items.Add($exit)
}

function Refresh-Profiles([bool]$clearStatus = $true) {
    try {
        $data = (& $NodePath $CliPath list --json 2>$null | Out-String) | ConvertFrom-Json
        $script:Profiles = @($data.profiles)
        $script:ActiveProfile = $script:Profiles | Where-Object active | Select-Object -First 1
        $profilesHost.Children.Clear()
        foreach ($profile in $script:Profiles) { [void]$profilesHost.Children.Add((New-ProfileCard $profile)) }
        [void]$profilesHost.Children.Add((New-AddCard))
        Rebuild-TrayMenu
        if ($clearStatus) { Set-OperationState "" $false }
    } catch {
        Set-OperationState "Profiles could not be loaded." $false
    }
}

function Get-SafeSwitchFailure {
    try {
        $audit = (& $NodePath $CliPath desktop audit --json 2>$null | Out-String) | ConvertFrom-Json
        if ($audit.outcome -eq "preflight-failed" -and $audit.error -match "401 Unauthorized|invalidated oauth token|token_revoked") {
            return "$($audit.to.label) sign-in expired. Its saved profile is intact; click it once to repair sign-in."
        }
        if ($audit.error -match "another Codex CLI process") { return "Another Codex operation is still running. Finish it, then try again." }
    } catch {}
    return "Switch failed safely. The previous account is still available."
}

function Show-ProfileWindow {
    Refresh-Profiles $false
    $mainWindow.Show()
    $mainWindow.WindowState = [Windows.WindowState]::Normal
    [void]$mainWindow.Activate()
}

function Stop-Launcher {
    $script:ExitRequested = $true
    $notifyIcon.Visible = $false
    $dockWindow.Close()
    $mainWindow.Close()
    [Windows.Application]::Current.Shutdown()
}

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
if ($script:CodexWhiteIcon) {
    try { $notifyIcon.Icon = New-Object System.Drawing.Icon($script:CodexWhiteIcon) } catch { $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application }
} else { $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application }
$notifyIcon.Text = "Codex Profile"
$notifyIcon.Visible = $false
$trayMenu = New-Object System.Windows.Forms.ContextMenuStrip
$notifyIcon.ContextMenuStrip = $trayMenu
$notifyIcon.Add_DoubleClick({ Show-ProfileWindow })

$mainWindow.Add_SourceInitialized({
    try {
        $helper = New-Object System.Windows.Interop.WindowInteropHelper($mainWindow)
        $preference = 2
        [void][CodexProfileNative]::DwmSetWindowAttribute($helper.Handle, 33, [ref]$preference, 4)
        $darkMode = 1
        [void][CodexProfileNative]::DwmSetWindowAttribute($helper.Handle, 20, [ref]$darkMode, 4)
    } catch {}
})
$titleBar.Add_PreviewMouseLeftButtonDown({
    param($sender, $eventArgs)
    if ($eventArgs.ChangedButton -ne [Windows.Input.MouseButton]::Left) { return }
    $source = $eventArgs.OriginalSource
    while ($source) {
        if ($source -is [Windows.Controls.Button]) { return }
        $source = [Windows.Media.VisualTreeHelper]::GetParent($source)
    }
    $mainWindow.DragMove()
})
$minimizeButton.Add_Click({ $mainWindow.WindowState = [Windows.WindowState]::Minimized })
$closeButton.Add_Click({ $mainWindow.Hide() })
$refreshButton.Add_Click({ Refresh-Profiles $true })
$profilesScroller.Add_PreviewMouseWheel({
    param($sender, $eventArgs)
    $sender.ScrollToHorizontalOffset($sender.HorizontalOffset - $eventArgs.Delta)
    $eventArgs.Handled = $true
})
$mainWindow.Add_StateChanged({ if ($mainWindow.WindowState -eq [Windows.WindowState]::Minimized) { $mainWindow.Hide() } })
$mainWindow.Add_Closing({ param($sender, $eventArgs) if (-not $script:ExitRequested) { $eventArgs.Cancel = $true; $mainWindow.Hide() } })

$dockSurface.Add_MouseLeftButtonUp({ Show-ProfileWindow })
$dockSurface.Add_MouseEnter({ $dockHover.Opacity = 0.08; $dockSurface.BorderBrush = New-SolidBrush "#73736F" })
$dockSurface.Add_MouseLeave({ $dockHover.Opacity = 0; $dockSurface.BorderBrush = New-SolidBrush "#4C4C49" })

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({
    if ($showEvent.WaitOne(0)) { Show-ProfileWindow }
    if ($script:SwitchProcess -and $script:SwitchProcess.HasExited) {
        $exitCode = $script:SwitchProcess.ExitCode
        $completedProfile = $script:PendingProfile
        $script:SwitchProcess = $null
        $script:PendingProfile = $null
        Refresh-Profiles $false
        if ($exitCode -eq 0) {
            Set-OperationState "" $false
            $notifyIcon.BalloonTipTitle = "Codex Profile"
            $notifyIcon.BalloonTipText = "Codex reopened as $($script:ActiveProfile.label)."
            $notifyIcon.ShowBalloonTip(3000)
        } else {
            Show-ProfileWindow
            Set-OperationState (Get-SafeSwitchFailure) $false
        }
    }
    if ($script:AddProcess -and $script:AddProcess.HasExited) {
        $exitCode = $script:AddProcess.ExitCode
        $script:AddProcess = $null
        Refresh-Profiles $false
        if ($exitCode -eq 0) { Set-OperationState "Account added. Choose it when you are ready." $false }
        else { Set-OperationState "The account was not added. Click Add account to try again." $false }
    }
    if (-not $isPreview) {
        $process = Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like '*\WindowsApps\OpenAI.Codex_*' } | Select-Object -First 1
        if ($process -and -not [CodexProfileNative]::IsIconic($process.MainWindowHandle)) {
            $rect = New-Object CodexProfileNative+RECT
            if ([CodexProfileNative]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) {
                $dpi = [CodexProfileNative]::GetDpiForWindow($process.MainWindowHandle)
                $scale = if ($dpi) { $dpi / 96.0 } else { 1.0 }
                $dockWindow.Left = ($rect.Right / $scale) - $dockWindow.Width - 42
                $dockWindow.Top = ($rect.Bottom / $scale) - $dockWindow.Height - 16
                if (-not $dockWindow.IsVisible) { $dockWindow.Show() }
            }
        } elseif ($dockWindow.IsVisible) { $dockWindow.Hide() }
    }
})
$timer.Start()

$application = New-Object Windows.Application
$application.ShutdownMode = [Windows.ShutdownMode]::OnExplicitShutdown
Refresh-Profiles $true

if ($isPreview) {
    $mainWindow.Show()
    $mainWindow.UpdateLayout()
    $width = [Math]::Max(1, [int]$mainWindow.ActualWidth)
    $height = [Math]::Max(1, [int]$mainWindow.ActualHeight)
    $bitmap = New-Object Windows.Media.Imaging.RenderTargetBitmap($width, $height, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($mainWindow)
    $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $directory = [IO.Path]::GetDirectoryName($PreviewPath)
    if ($directory) { [void][IO.Directory]::CreateDirectory($directory) }
    $stream = [IO.File]::Open($PreviewPath, [IO.FileMode]::Create)
    try { $encoder.Save($stream) } finally { $stream.Dispose() }
    $script:ExitRequested = $true
    $mainWindow.Close()
} else {
    if (-not $StartHidden) { $mainWindow.Show() }
    [void]$application.Run()
}

$timer.Stop()
$notifyIcon.Visible = $false
$notifyIcon.Dispose()
$showEvent.Dispose()
$instanceMutex.ReleaseMutex()
$instanceMutex.Dispose()
