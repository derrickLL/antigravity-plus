using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class NativeApproval
{
    private static void WriteDiag(string installRoot, string message)
    {
        try
        {
            string logDir = Path.Combine(installRoot, "logs");
            Directory.CreateDirectory(logDir);
            string logFile = Path.Combine(logDir, "native-approval.log");
            File.AppendAllText(logFile, "[" + DateTime.Now.ToString("O") + "] " + message + Environment.NewLine, Encoding.UTF8);
        }
        catch { }
    }

    private static string NormalizeInstallRootForHash(string installRoot)
    {
        if (string.IsNullOrWhiteSpace(installRoot)) return "";
        string full = Path.GetFullPath(installRoot);
        string root = Path.GetPathRoot(full);
        if (!string.IsNullOrEmpty(root) && string.Equals(full, root, StringComparison.OrdinalIgnoreCase))
        {
            return full.ToLowerInvariant();
        }
        return full.TrimEnd('\\', '/').ToLowerInvariant();
    }

    // Only the toast's Submit handler reaches this path. The running MainBridge
    // forwards the explicit signed selection to the Hub without opening or focusing a window.
    internal static bool Submit(string installRoot, string conversationId, string requestKey, string key, int optionIndex, bool deny)
    {
        string pipeName = "AgyPlus-MainBridge-" + TaskToastProgram.ComputeHash20(NormalizeInstallRootForHash(installRoot));
        try
        {
            var decision = new Dictionary<string, object> {
                { "kind", "native_permission" },
                { "requestKey", requestKey },
                { "key", key },
                { "optionIndex", optionIndex },
                { "deny", deny }
            };
            var reply = Request(pipeName, new Dictionary<string, object> {
                { "action", "submit_question" },
                { "conversationId", conversationId },
                { "selections", new[] { decision } }
            }, 9000);
            object submitted;
            bool accepted = reply != null && reply.TryGetValue("submitted", out submitted) && object.Equals(submitted, true);
            object error;
            string reason = reply != null && reply.TryGetValue("error", out error) ? error as string : null;
            if (reason != null && !System.Text.RegularExpressions.Regex.IsMatch(reason, "^[a-z_]{1,48}$")) reason = null;
            WriteDiag(installRoot, accepted
                ? "Background approval accepted by Antigravity"
                : "Background approval unconfirmed: " + (reason ?? "bridge_no_confirmation"));
            if (accepted)
            {
                try { Request(pipeName, new Dictionary<string, object> { { "action", "sync_now" } }, 1200); } catch { }
            }
            return accepted;
        }
        catch (Exception ex)
        {
            WriteDiag(installRoot, "Background approval bridge error: " + ex.GetType().Name);
            return false;
        }
    }

    private static string ReadLineWithTimeout(NamedPipeClientStream pipe, int timeoutMs)
    {
        using (var cts = new CancellationTokenSource(timeoutMs))
        using (cts.Token.Register(() => { try { pipe.Dispose(); } catch { } }))
        using (var ms = new MemoryStream(512))
        {
            byte[] buf = new byte[4096];
            const int maxBytes = 2 * 1024 * 1024;
            while (true)
            {
                Task<int> readTask = pipe.ReadAsync(buf, 0, buf.Length, cts.Token);
                int read;
                try
                {
                    read = readTask.GetAwaiter().GetResult();
                }
                catch (OperationCanceledException)
                {
                    return null;
                }
                catch (ObjectDisposedException)
                {
                    return null;
                }
                catch (IOException)
                {
                    return null;
                }
                if (read <= 0) break;
                int nl = Array.IndexOf(buf, (byte)'\n', 0, read);
                int take = nl >= 0 ? nl : read;
                if (ms.Length + take > maxBytes) return null;
                if (take > 0) ms.Write(buf, 0, take);
                if (nl >= 0) break;
            }
            byte[] raw = ms.ToArray();
            int len = raw.Length;
            if (len > 0 && raw[len - 1] == (byte)'\r') len--;
            return Encoding.UTF8.GetString(raw, 0, len);
        }
    }

    private static Dictionary<string, object> Request(string pipeName, Dictionary<string, object> request, int timeoutMs)
    {
        var json = new JavaScriptSerializer();
        using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous))
        {
            pipe.Connect(1500);
            byte[] data = Encoding.UTF8.GetBytes(json.Serialize(request) + "\n");
            using (var writeCts = new CancellationTokenSource(Math.Min(timeoutMs, 3000)))
            using (writeCts.Token.Register(() => { try { pipe.Dispose(); } catch { } }))
            {
                pipe.WriteAsync(data, 0, data.Length, writeCts.Token).GetAwaiter().GetResult();
                pipe.FlushAsync(writeCts.Token).GetAwaiter().GetResult();
            }
            string line = ReadLineWithTimeout(pipe, timeoutMs);
            if (string.IsNullOrEmpty(line)) return null;
            return json.Deserialize<Dictionary<string, object>>(line);
        }
    }
}
