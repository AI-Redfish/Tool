# WinForms 测试夹具：为 jev-desktop 语义动作提供真实 UIA 控件面。
#
# 启动：powershell -ExecutionPolicy Bypass -File tests/fixture_winforms.ps1
# 或（后台隐藏控制台）：powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File tests/fixture_winforms.ps1
#
# 窗口标题固定为 "jev-fixture-窗口"（供 --title 匹配）。
# 控件：
#   按钮  "确定"   → 点击后标签显示 "已点击 N 次"（可从快照验证）
#   复选框 "选项A" → 初始未勾选（toggle/check/uncheck 目标）
#   复选框 "选项B" → 初始已勾选（uncheck 目标）
#   文本框 "示例输入"（set_value/extract 目标，初值 hello）
#   下拉框 "颜色"  → 苹果/香蕉/橙子（select/expand 目标）

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "jev-fixture-窗口"
$form.Size = New-Object System.Drawing.Size(420, 360)
$form.StartPosition = "Manual"
$form.Location = New-Object System.Drawing.Point(120, 120)

$script:clicks = 0

$btn = New-Object System.Windows.Forms.Button
$btn.Name = "OkButton"
$btn.Text = "确定"
$btn.Location = New-Object System.Drawing.Point(20, 20)
$btn.Size = New-Object System.Drawing.Size(120, 32)

$label = New-Object System.Windows.Forms.Label
$label.Name = "StatusLabel"
$label.Text = "已点击 0 次"
$label.Location = New-Object System.Drawing.Point(160, 26)
$label.Size = New-Object System.Drawing.Size(200, 24)

$checkA = New-Object System.Windows.Forms.CheckBox
$checkA.Name = "CheckA"
$checkA.Text = "选项A"
$checkA.Location = New-Object System.Drawing.Point(20, 70)
$checkA.Size = New-Object System.Drawing.Size(160, 26)

$checkB = New-Object System.Windows.Forms.CheckBox
$checkB.Name = "CheckB"
$checkB.Text = "选项B"
$checkB.Checked = $true
$checkB.Location = New-Object System.Drawing.Point(20, 104)
$checkB.Size = New-Object System.Drawing.Size(160, 26)

$textbox = New-Object System.Windows.Forms.TextBox
$textbox.Name = "SampleInput"
$textbox.Location = New-Object System.Drawing.Point(20, 150)
$textbox.Size = New-Object System.Drawing.Size(300, 26)
$textbox.Text = "hello"

$combo = New-Object System.Windows.Forms.ComboBox
$combo.Name = "ColorBox"
$combo.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
$combo.Location = New-Object System.Drawing.Point(20, 190)
$combo.Size = New-Object System.Drawing.Size(200, 26)
[void]$combo.Items.Add("苹果")
[void]$combo.Items.Add("香蕉")
[void]$combo.Items.Add("橙子")
$combo.SelectedIndex = 0

$btn.Add_Click({
    $script:clicks++
    $label.Text = "已点击 $script:clicks 次"
})

$form.Controls.AddRange(@($btn, $label, $checkA, $checkB, $textbox, $combo))

[System.Windows.Forms.Application]::EnableVisualStyles() | Out-Null
$form.Topmost = $true
[void]$form.ShowDialog()
