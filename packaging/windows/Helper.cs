using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.VisualBasic.ApplicationServices;
using Microsoft.Win32;

// A launcher and local lifecycle UI. All project effects stay in the Rust runner.
internal static class PairingLink
{
    internal static string[] Parse(string value)
    {
        Uri uri;
        if (value.Length > 2048 || !Uri.TryCreate(value, UriKind.Absolute, out uri) ||
            uri.Scheme != "ahm" || uri.Host != "connect" || uri.UserInfo != "" ||
            uri.Fragment != "" || (uri.AbsolutePath != "" && uri.AbsolutePath != "/") || !uri.IsDefaultPort)
            throw new ArgumentException("Invalid connection link. Generate a new link in Skills Hub.");
        var query = HttpUtility.ParseQueryString(uri.Query);
        if (query.Count != 2 || query.GetValues("code") == null || query.GetValues("code").Length != 1 ||
            query.GetValues("server") == null || query.GetValues("server").Length != 1)
            throw new ArgumentException("Invalid connection link.");
        var code = query["code"];
        Uri server;
        if (!Regex.IsMatch(code, "\\A[A-Za-z0-9_-]{16,256}\\z") ||
            !Uri.TryCreate(query["server"], UriKind.Absolute, out server) || server.Scheme != "https" ||
            server.UserInfo != "" || server.Query != "" || server.Fragment != "" ||
            server.AbsolutePath != "/" || !server.IsDefaultPort)
            throw new ArgumentException("Connection requires a valid code and an HTTPS server origin.");
        return new[] { code, server.GetLeftPart(UriPartial.Authority) };
    }
}

internal sealed class HelperApp : WindowsFormsApplicationBase
{
    private Mutex installationLock;
    internal HelperApp() { IsSingleInstance = true; EnableVisualStyles = true; }
    protected override void OnCreateMainForm()
    {
        installationLock = new Mutex(false, "SkillsHubHelper");
        MainForm = new HelperWindow(CommandLineArgs.ToArray());
    }
    protected override void OnStartupNextInstance(StartupNextInstanceEventArgs e)
    {
        ((HelperWindow)MainForm).Receive(e.CommandLine.ToArray());
        e.BringToForeground = false;
    }
    protected override void OnShutdown() { if (installationLock != null) installationLock.Dispose(); base.OnShutdown(); }
    [STAThread] private static void Main(string[] args) { new HelperApp().Run(args); }
}

internal sealed class HelperWindow : Form
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunName = "SkillsHubHelper";
    private readonly string binary = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ahm.exe");
    private readonly Label status = new Label { AutoSize = true, Text = "Checking helper status…" };
    private readonly Button start = new Button { AutoSize = true, Text = "Start" };
    private readonly Button stop = new Button { AutoSize = true, Text = "Stop" };
    private readonly Button pair = new Button { AutoSize = true, Text = "Connect" };
    private readonly TextBox link = new TextBox { Width = 450, AccessibleName = "Connection link", UseSystemPasswordChar = true };
    private readonly CheckBox startup = new CheckBox { AutoSize = true, Text = "Start helper when I sign in to Windows" };
    private readonly NotifyIcon tray;
    private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 2000 };
    private bool refreshing, busy, running, stopping, exiting;
    private readonly string[] initialArgs;

    internal HelperWindow(string[] args)
    {
        initialArgs = args;
        Text = "Skills Hub helper";
        Icon = SystemIcons.Application;
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(520, 380);
        MinimumSize = new Size(480, 390);
        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(20), AutoScroll = true };
        layout.Controls.Add(new Label { Text = "Skills Hub helper", Font = new Font(Font, FontStyle.Bold), AutoSize = true });
        layout.Controls.Add(status);
        var buttons = new FlowLayoutPanel { AutoSize = true };
        buttons.Controls.Add(start); buttons.Controls.Add(stop);
        layout.Controls.Add(buttons);
        layout.Controls.Add(new Label { MaximumSize = new Size(460, 0), AutoSize = true, Text = "Stop finishes the current poll or operation first. Closing this window keeps the helper in the notification area. Your skills and project files are preserved." });
        layout.Controls.Add(startup);
        layout.Controls.Add(new Label { AutoSize = true, Text = "Connect from the website, or paste its connection link:" });
        layout.Controls.Add(link); layout.Controls.Add(pair);
        layout.Controls.Add(new Label { MaximumSize = new Size(460, 0), AutoSize = true, Text = "Only the pairing code expires after 10 minutes. Once connected, the helper reconnects automatically after network loss." });
        var website = new LinkLabel { AutoSize = true, Text = "Open Skills Hub" };
        website.LinkClicked += delegate { Process.Start("https://skill-manager.omarjetti.dev"); };
        layout.Controls.Add(website);
        Controls.Add(layout);
        using (var key = Registry.CurrentUser.OpenSubKey(RunKey)) startup.Checked = key != null && key.GetValue(RunName) != null;
        startup.CheckedChanged += delegate {
            try {
                using (var key = Registry.CurrentUser.CreateSubKey(RunKey)) {
                    if (startup.Checked) key.SetValue(RunName, "\"" + Application.ExecutablePath + "\" --background");
                    else key.DeleteValue(RunName, false);
                }
            } catch { MessageBox.Show(this, "Could not change sign-in startup. Check your Windows account permissions.", Text); }
        };
        start.Click += async delegate { await StartWorker(); };
        stop.Click += async delegate { await StopWorker(false); };
        pair.Click += async delegate { await Connect(); };
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open helper", null, delegate { Reveal(); });
        menu.Items.Add("Start", null, async delegate { await StartWorker(); });
        menu.Items.Add("Stop", null, async delegate { await StopWorker(false); });
        menu.Items.Add("Quit after current work", null, async delegate { await StopWorker(true); });
        tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "Skills Hub helper", Visible = true, ContextMenuStrip = menu };
        tray.DoubleClick += delegate { Reveal(); };
        timer.Tick += async delegate { await RefreshStatus(); };
        Shown += async delegate { timer.Start(); await RefreshStatus(); Receive(initialArgs); };
        FormClosing += delegate(object sender, FormClosingEventArgs e) { if (!exiting) { e.Cancel = true; Hide(); } };
        FormClosed += delegate { timer.Dispose(); tray.Dispose(); };
    }

    internal async void Receive(string[] args)
    {
        if (args.Length == 1 && args[0] == "--shutdown") { await StopWorker(true); return; }
        if (args.Length == 1 && args[0] == "--background") { Hide(); await StartWorker(); return; }
        Reveal();
        if (args.Length == 1 && (args[0] == "ahm://open" || args[0] == "ahm://open/")) return;
        if (args.Length == 1 && args[0].StartsWith("ahm:", StringComparison.OrdinalIgnoreCase)) {
            try { PairingLink.Parse(args[0]); link.Text = args[0]; }
            catch (ArgumentException e) { MessageBox.Show(this, e.Message, Text); }
        }
    }
    private void Reveal() { Show(); WindowState = FormWindowState.Normal; Activate(); }

    private Task<Tuple<int, string>> Run(string arguments)
    {
        return Task.Run(() => {
            using (var process = new Process { StartInfo = new ProcessStartInfo(binary, arguments) {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory
            } }) {
                process.Start();
                var output = process.StandardOutput.ReadToEndAsync();
                var error = process.StandardError.ReadToEndAsync();
                process.WaitForExit(); Task.WaitAll(output, error);
                // Never display or persist raw enrollment/network output (may contain a code).
                return Tuple.Create(process.ExitCode, output.Result);
            }
        });
    }

    private async Task RefreshStatus()
    {
        if (refreshing) return;
        refreshing = true;
        try {
            var result = await Run("--json worker --status");
            if (result.Item1 != 0) throw new IOException();
            var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(result.Item2);
            running = (bool)data["running"];
            var report = data["report"] as Dictionary<string, object>;
            var state = report == null ? "starting" : (string)report["state"];
            status.Text = stopping && running ? "Stopping after current work…" : !running ? "Stopped" :
                state == "connected" ? "Running · connected" : state == "offline" ? "Running · offline, retrying automatically" : "Running · connecting…";
            if (!running) stopping = false;
            start.Enabled = !busy && !running;
            stop.Enabled = !busy && running && !stopping;
        } catch { status.Text = "Status unavailable. Reinstall the helper or try again."; }
        finally { refreshing = false; }
    }

    private async Task StartWorker()
    {
        if (busy || stopping) return;
        busy = true;
        try {
            var check = await Run("--json worker --status");
            var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(check.Item2);
            if (!(bool)data["running"]) {
                using (var child = Process.Start(new ProcessStartInfo(binary, "worker") { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory })) {
                    await Task.Delay(700);
                    if (child.HasExited && child.ExitCode != 0) MessageBox.Show(this, "The worker could not start. Connect this computer from Skills Hub first.", Text);
                }
            }
        } catch { MessageBox.Show(this, "Could not start the worker. Reinstall the helper and retry.", Text); }
        finally { busy = false; }
        await RefreshStatus();
    }

    private async Task StopWorker(bool quit)
    {
        if (busy) return;
        busy = true; stopping = true;
        try {
            var result = await Run(quit ? "worker --stop --wait" : "worker --stop");
            if (result.Item1 != 0) { MessageBox.Show(this, "Work is still finishing. Wait and try again; no operation was killed.", Text); return; }
            if (quit) { exiting = true; Close(); }
        } catch { MessageBox.Show(this, "Could not request a stop. The worker was left intact.", Text); }
        finally { busy = false; }
        if (!exiting) await RefreshStatus();
    }

    private async Task Connect()
    {
        if (busy) return;
        string[] pairing;
        try { pairing = PairingLink.Parse(link.Text); }
        catch (ArgumentException e) { MessageBox.Show(this, e.Message, Text); return; }
        if (MessageBox.Show(this, "Connect this computer to " + pairing[1] + "?\n\nThis replaces any existing connection. Current work must finish first.", Text, MessageBoxButtons.OKCancel) != DialogResult.OK) return;
        busy = true; pair.Enabled = false; status.Text = "Finishing work and connecting…";
        bool connected = false;
        try {
            var stopped = await Run("worker --stop --wait");
            if (stopped.Item1 != 0) throw new IOException();
            var result = await Run("connect " + pairing[0] + " --server \"" + pairing[1] + "\"");
            connected = result.Item1 == 0;
            link.Clear();
            if (!connected) MessageBox.Show(this, "Connection failed. The code may be expired or already used, or the server unavailable. Generate a new code on the website and try again.", Text);
        } catch { MessageBox.Show(this, "Connection did not finish. Wait for current work, then retry with a fresh link.", Text); }
        finally { busy = false; pair.Enabled = true; stopping = false; }
        if (connected) await StartWorker(); else await RefreshStatus();
    }
}
