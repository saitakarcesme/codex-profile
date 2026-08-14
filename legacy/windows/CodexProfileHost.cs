using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

internal static class CodexProfileHost
{
    [DllImport("shell32.dll", SetLastError = true)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            SetCurrentProcessExplicitAppUserModelID("OpenAI.CodexProfile");
            var options = Parse(args);
            var automation = Assembly.LoadFrom(options["automation"]);
            var runspaceFactory = automation.GetType("System.Management.Automation.Runspaces.RunspaceFactory", true);
            var runspace = runspaceFactory.GetMethod("CreateRunspace", Type.EmptyTypes).Invoke(null, null);
            var runspaceType = runspace.GetType();
            runspaceType.GetProperty("ApartmentState").SetValue(runspace, System.Threading.ApartmentState.STA, null);
            var threadOptions = runspaceType.GetProperty("ThreadOptions");
            threadOptions.SetValue(runspace, Enum.Parse(threadOptions.PropertyType, "UseCurrentThread"), null);
            runspaceType.GetMethod("Open", Type.EmptyTypes).Invoke(runspace, null);
            try
            {
                var shellType = automation.GetType("System.Management.Automation.PowerShell", true);
                var shell = shellType.GetMethod("Create", Type.EmptyTypes).Invoke(null, null);
                try
                {
                    shellType.GetProperty("Runspace").SetValue(shell, runspace, null);
                    var addCommand = shellType.GetMethod("AddCommand", new[] { typeof(string) });
                    var addParameterValue = shellType.GetMethod("AddParameter", new[] { typeof(string), typeof(object) });
                    addCommand.Invoke(shell, new object[] { options["script"] });
                    addParameterValue.Invoke(shell, new object[] { "NodePath", options["node"] });
                    addParameterValue.Invoke(shell, new object[] { "CliPath", options["cli"] });
                    addParameterValue.Invoke(shell, new object[] { "WorkingDirectory", options["cwd"] });
                    addParameterValue.Invoke(shell, new object[] { "BrandIconPath", options["brand"] });
                    if (options.ContainsKey("start-hidden")) addParameterValue.Invoke(shell, new object[] { "StartHidden", true });
                    if (options.ContainsKey("preview")) addParameterValue.Invoke(shell, new object[] { "PreviewPath", options["preview"] });
                    FindNoArgumentMethod(shellType, "Invoke").Invoke(shell, null);
                    if ((bool)shellType.GetProperty("HadErrors").GetValue(shell, null))
                    {
                        WriteDiagnostic("PowerShell pipeline failed");
                        return 1;
                    }
                    ClearDiagnostic();
                    return 0;
                }
                finally { ((IDisposable)shell).Dispose(); }
            }
            finally { ((IDisposable)runspace).Dispose(); }
        }
        catch (Exception error)
        {
            WriteDiagnostic(error.GetType().FullName + (error.InnerException == null ? "" : " -> " + error.InnerException.GetType().FullName));
            return 1;
        }
    }

    private static Dictionary<string, string> Parse(string[] args)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < args.Length; index++)
        {
            var key = args[index];
            if (key == "--start-hidden")
            {
                result["start-hidden"] = "true";
                continue;
            }
            if (!key.StartsWith("--", StringComparison.Ordinal) || index + 1 >= args.Length)
                throw new ArgumentException("Invalid Codex Profile host arguments.");
            result[key.Substring(2)] = args[++index];
        }
        foreach (var required in new[] { "script", "node", "cli", "cwd", "automation", "brand" })
            if (!result.ContainsKey(required) || String.IsNullOrWhiteSpace(result[required]))
                throw new ArgumentException("Missing Codex Profile host argument: " + required);
        return result;
    }

    private static MethodInfo FindNoArgumentMethod(Type type, string name)
    {
        foreach (var method in type.GetMethods())
            if (method.Name == name && !method.IsGenericMethod && method.GetParameters().Length == 0)
                return method;
        throw new MissingMethodException(type.FullName, name);
    }

    private static string DiagnosticPath()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexProfile", "host-startup-error.txt");
    }

    private static void WriteDiagnostic(string text)
    {
        try { File.WriteAllText(DiagnosticPath(), text); } catch { }
    }

    private static void ClearDiagnostic()
    {
        try { if (File.Exists(DiagnosticPath())) File.Delete(DiagnosticPath()); } catch { }
    }
}
