using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using Oxide.Core;
using Oxide.Core.Libraries;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.Networking;

namespace Oxide.Plugins
{
    [Info("VoiceMonitor", "5HeadNN", "1.0.5")]
    [Description("Monitors voice chat and sends transcripts to Ruscar Bot via RCON for moderation")]
    public class VoiceMonitor : RustPlugin
    {
        private readonly Dictionary<ulong, List<byte[]>> _voiceBuffer = new Dictionary<ulong, List<byte[]>>();
        private readonly Dictionary<ulong, float> _lastSendTime = new Dictionary<ulong, float>();
        private readonly HashSet<ulong> _processing = new HashSet<ulong>();

        private class KeyConfig { public string GroqKey = ""; }
        private KeyConfig _config = new KeyConfig();

        private const float BUFFER_SECONDS = 3f;
        private const int MIN_CHUNKS = 10;

        private static byte[] CreateWavHeader(int dataLength, int sampleRate = 24000, short channels = 1, short bitsPerSample = 16)
        {
            byte[] h = new byte[44];
            void WriteInt(int v, int pos) { h[pos]=(byte)v; h[pos+1]=(byte)(v>>8); h[pos+2]=(byte)(v>>16); h[pos+3]=(byte)(v>>24); }
            void WriteShort(short v, int pos) { h[pos]=(byte)v; h[pos+1]=(byte)(v>>8); }
            h[0]=(byte)'R'; h[1]=(byte)'I'; h[2]=(byte)'F'; h[3]=(byte)'F';
            WriteInt(dataLength + 36, 4);
            h[8]=(byte)'W'; h[9]=(byte)'A'; h[10]=(byte)'V'; h[11]=(byte)'E';
            h[12]=(byte)'f'; h[13]=(byte)'m'; h[14]=(byte)'t'; h[15]=(byte)' ';
            WriteInt(16, 16); WriteShort(1, 20); WriteShort(channels, 22);
            WriteInt(sampleRate, 24);
            WriteInt(sampleRate * channels * bitsPerSample / 8, 28);
            WriteShort((short)(channels * bitsPerSample / 8), 32);
            WriteShort(bitsPerSample, 34);
            h[36]=(byte)'d'; h[37]=(byte)'a'; h[38]=(byte)'t'; h[39]=(byte)'a';
            WriteInt(dataLength, 40);
            return h;
        }

        private void Init()
        {
            _config = Interface.Oxide.DataFileSystem.ReadObject<KeyConfig>("VoiceMonitorKey") ?? new KeyConfig();
            if (string.IsNullOrEmpty(_config.GroqKey))
                Puts("[VoiceMonitor] WARNING: No Groq API key set! Use: voicemonitor.setkey YOUR_KEY");
            else
                Puts("[VoiceMonitor] Started — monitoring all voice chat.");
        }

        [ConsoleCommand("voicemonitor.setkey")]
        private void SetKeyCommand(ConsoleSystem.Arg arg)
        {
            if (arg.Args == null || arg.Args.Length < 1) { Puts("Usage: voicemonitor.setkey YOUR_GROQ_KEY"); return; }
            _config.GroqKey = arg.Args[0];
            Interface.Oxide.DataFileSystem.WriteObject("VoiceMonitorKey", _config);
            Puts("[VoiceMonitor] Groq API key saved.");
        }

        private void OnPlayerVoice(BasePlayer player, byte[] data)
        {
            if (player == null || data == null || data.Length == 0) return;
            if (string.IsNullOrEmpty(_config.GroqKey)) return;
            if (_processing.Contains(player.userID)) return;

            ulong uid = player.userID;
            if (!_voiceBuffer.ContainsKey(uid)) _voiceBuffer[uid] = new List<byte[]>();
            if (!_lastSendTime.ContainsKey(uid)) _lastSendTime[uid] = UnityEngine.Time.realtimeSinceStartup;

            _voiceBuffer[uid].Add(data);

            float elapsed = UnityEngine.Time.realtimeSinceStartup - _lastSendTime[uid];
            if (elapsed >= BUFFER_SECONDS && _voiceBuffer[uid].Count >= MIN_CHUNKS)
            {
                var chunks = _voiceBuffer[uid].ToArray();
                _voiceBuffer[uid].Clear();
                _lastSendTime[uid] = UnityEngine.Time.realtimeSinceStartup;
                _processing.Add(uid);
                ServerMgr.Instance.StartCoroutine(TranscribeCoroutine(uid, player.displayName, player.UserIDString, chunks));
            }
        }

        private IEnumerator TranscribeCoroutine(ulong uid, string username, string steamId, byte[][] chunks)
        {
            // Combine chunks
            int totalLength = 0;
            foreach (var chunk in chunks) totalLength += chunk.Length;
            byte[] pcm = new byte[totalLength];
            int offset = 0;
            foreach (var chunk in chunks) { Buffer.BlockCopy(chunk, 0, pcm, offset, chunk.Length); offset += chunk.Length; }

            // Wrap in WAV
            byte[] wavHeader = CreateWavHeader(pcm.Length);
            byte[] wav = new byte[wavHeader.Length + pcm.Length];
            Buffer.BlockCopy(wavHeader, 0, wav, 0, wavHeader.Length);
            Buffer.BlockCopy(pcm, 0, wav, wavHeader.Length, pcm.Length);

            // Build multipart form
            string boundary = "----RuscarVoice" + System.DateTime.Now.Ticks;
            byte[] boundaryBytes = Encoding.UTF8.GetBytes("--" + boundary + "\r\n");
            byte[] modelField = Encoding.UTF8.GetBytes("Content-Disposition: form-data; name=\"model\"\r\n\r\nwhisper-large-v3\r\n");
            byte[] fmtField = Encoding.UTF8.GetBytes("--" + boundary + "\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\njson\r\n");
            byte[] audioFieldHeader = Encoding.UTF8.GetBytes("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"voice.wav\"\r\nContent-Type: audio/wav\r\n\r\n");
            byte[] footerBytes = Encoding.UTF8.GetBytes("\r\n--" + boundary + "--\r\n");

            int bodyLen = boundaryBytes.Length + modelField.Length + fmtField.Length + audioFieldHeader.Length + wav.Length + footerBytes.Length;
            byte[] body = new byte[bodyLen];
            int pos = 0;
            void Append(byte[] src) { Buffer.BlockCopy(src, 0, body, pos, src.Length); pos += src.Length; }
            Append(boundaryBytes); Append(modelField); Append(fmtField); Append(audioFieldHeader); Append(wav); Append(footerBytes);

            var req = new UnityWebRequest("https://api.groq.com/openai/v1/audio/transcriptions", "POST");
            req.uploadHandler = new UploadHandlerRaw(body);
            req.downloadHandler = new DownloadHandlerBuffer();
            req.SetRequestHeader("Authorization", "Bearer " + _config.GroqKey);
            req.SetRequestHeader("Content-Type", "multipart/form-data; boundary=" + boundary);

            yield return req.SendWebRequest();

            _processing.Remove(uid);

            if (req.responseCode != 200)
            {
                Puts("[VoiceMonitor] Groq error " + req.responseCode + ": " + req.downloadHandler.text);
                yield break;
            }

            try
            {
                JObject result = JObject.Parse(req.downloadHandler.text);
                string transcript = result["text"]?.Value<string>() ?? "";
                if (string.IsNullOrWhiteSpace(transcript)) yield break;
                Puts("[VOICE] " + username + " (" + steamId + "): " + transcript);
                // Send as a fake chat message the bot can intercept
                Server.Broadcast("[VOICETRANSCRIPT] " + steamId + " " + username + ": " + transcript);
            }
            catch (Exception ex) { Puts("[VoiceMonitor] Parse error: " + ex.Message); }
        }

        private void OnPlayerDisconnected(BasePlayer player, string reason)
        {
            if (player == null) return;
            _voiceBuffer.Remove(player.userID);
            _lastSendTime.Remove(player.userID);
            _processing.Remove(player.userID);
        }
    }
}
