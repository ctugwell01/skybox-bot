using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using Oxide.Core;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.Networking;

namespace Oxide.Plugins
{
    [Info("VoiceMonitor", "5HeadNN", "1.5.0")]
    [Description("Monitors voice chat using Deepgram Nova-3")]
    public class VoiceMonitor : RustPlugin
    {
        private readonly Dictionary<ulong, List<byte[]>> _voiceBuffer = new Dictionary<ulong, List<byte[]>>();
        private readonly Dictionary<ulong, float> _lastSendTime = new Dictionary<ulong, float>();
        private readonly HashSet<ulong> _processing = new HashSet<ulong>();

        private class KeyConfig { public string ApiKey = ""; }
        private KeyConfig _config = new KeyConfig();

        private const float BUFFER_SECONDS = 4f;  // send every 4 seconds
        private const int MIN_CHUNKS = 5;           // minimum chunks before sending
        private const float SILENCE_THRESHOLD = 1f; // send early if 1s of silence
        private const int SAMPLE_RATE = 24000;
        private const int SAMPLES_PER_FRAME = 480; // 20ms at 24000Hz

        // OGG MSB-first CRC32
        private static uint OggCrc32(byte[] data)
        {
            uint crc = 0;
            foreach (byte b in data)
            {
                crc ^= (uint)b << 24;
                for (int j = 0; j < 8; j++)
                    crc = (crc & 0x80000000u) != 0 ? ((crc << 1) ^ 0x04c11db7u) : (crc << 1);
            }
            return crc;
        }

        private static byte[] BuildOggOpus(List<byte[]> frames)
        {
            var result = new List<byte>();
            uint serial = 0x12345678;
            uint pageSeq = 0;
            long granulePos = 0;

            byte[] MakePage(byte[] pageData, bool bos, bool eos)
            {
                // Build lacing values
                var lacing = new List<byte>();
                int rem = pageData.Length;
                while (rem > 255) { lacing.Add(255); rem -= 255; }
                lacing.Add((byte)rem);

                byte[] page = new byte[27 + lacing.Count + pageData.Length];
                // capture_pattern
                page[0]=(byte)'O'; page[1]=(byte)'g'; page[2]=(byte)'g'; page[3]=(byte)'S';
                page[4] = 0; // stream_structure_version
                page[5] = (byte)((bos?0x02:0)|(eos?0x04:0)); // header_type_flag
                // granule_position (int64 LE)
                long gp = bos ? 0 : granulePos;
                for (int i=0;i<8;i++) page[6+i]=(byte)(gp>>(i*8));
                // bitstream_serial_number
                for (int i=0;i<4;i++) page[14+i]=(byte)(serial>>(i*8));
                // page_sequence_number
                for (int i=0;i<4;i++) page[18+i]=(byte)(pageSeq>>(i*8));
                pageSeq++;
                // checksum = 0 for CRC calculation
                page[22]=0; page[23]=0; page[24]=0; page[25]=0;
                // number_page_segments
                page[26]=(byte)lacing.Count;
                for (int i=0;i<lacing.Count;i++) page[27+i]=lacing[i];
                Buffer.BlockCopy(pageData, 0, page, 27+lacing.Count, pageData.Length);
                // compute and insert CRC
                uint crc = OggCrc32(page);
                page[22]=(byte)crc; page[23]=(byte)(crc>>8);
                page[24]=(byte)(crc>>16); page[25]=(byte)(crc>>24);
                return page;
            }

            // OpusHead - identification header
            // sample rate MUST match what encoder used (24000)
            byte[] opusHead = new byte[] {
                0x4F,0x70,0x75,0x73,0x48,0x65,0x61,0x64, // "OpusHead"
                0x01,       // version = 1
                0x01,       // channel count = 1 (mono)
                0x00,0x00,  // pre-skip = 0
                // input_sample_rate = 24000 = 0x00005DC0 (little endian)
                0xC0,0x5D,0x00,0x00,
                0x00,0x00,  // output_gain = 0
                0x00        // channel mapping family = 0
            };
            result.AddRange(MakePage(opusHead, true, false));

            // OpusTags - comment header
            byte[] vendor = Encoding.UTF8.GetBytes("RuscarBot");
            var tags = new List<byte>();
            tags.AddRange(Encoding.UTF8.GetBytes("OpusTags"));
            // vendor string length (LE uint32)
            tags.Add((byte)vendor.Length); tags.Add(0); tags.Add(0); tags.Add(0);
            tags.AddRange(vendor);
            // user comment list length = 0
            tags.Add(0); tags.Add(0); tags.Add(0); tags.Add(0);
            result.AddRange(MakePage(tags.ToArray(), false, false));

            // Audio pages — one Opus frame per page
            for (int i = 0; i < frames.Count; i++)
            {
                granulePos += SAMPLES_PER_FRAME;
                bool last = (i == frames.Count - 1);
                result.AddRange(MakePage(frames[i], false, last));
            }

            return result.ToArray();
        }

        private static List<byte[]> ParseSteamVoice(byte[][] chunks)
        {
            var frames = new List<byte[]>();
            foreach (var chunk in chunks)
            {
                if (chunk.Length < 9) continue;
                int pos = 8; // skip 8-byte Steam header
                while (pos < chunk.Length - 2)
                {
                    byte ptype = chunk[pos++];
                    if (ptype == 0x0B) { pos += 2; continue; } // sample rate, skip 2 bytes
                    if (ptype == 0x06)
                    {
                        if (pos + 2 > chunk.Length) break;
                        int chunkSize = chunk[pos] | (chunk[pos+1]<<8); pos += 2;
                        int chunkEnd = pos + chunkSize;
                        while (pos + 4 <= chunkEnd && pos + 4 <= chunk.Length)
                        {
                            int fsize = chunk[pos] | (chunk[pos+1]<<8); pos += 2;
                            if (fsize == 0xFFFF) break; // end of transmission
                            pos += 2; // skip sequence number
                            // fsize includes the full opus frame - DO NOT skip 0x68, it's part of the data
                            if (fsize > 0 && pos + fsize <= chunk.Length)
                            {
                                var frame = new byte[fsize];
                                Buffer.BlockCopy(chunk, pos, frame, 0, fsize);
                                if (fsize > 3) frames.Add(frame); // skip silence frames
                            }
                            pos += fsize;
                        }
                        pos = chunkEnd; // move past this chunk
                        continue;
                    }
                    if (ptype == 0x00) { pos += 2; continue; } // silence payload
                    break; // unknown type
                }
            }
            return frames;
        }

        private void Init()
        {
            _config = Interface.Oxide.DataFileSystem.ReadObject<KeyConfig>("VoiceMonitorKey") ?? new KeyConfig();
            if (string.IsNullOrEmpty(_config.ApiKey))
                Puts("[VoiceMonitor] v1.5.0 WARNING: No Deepgram API key set! Use: voicemonitor.setkey YOUR_KEY");
            else
                Puts("[VoiceMonitor] v1.5.0 Started — monitoring voice chat with Deepgram Nova-3.");
        }

        [ConsoleCommand("voicemonitor.setkey")]
        private void SetKeyCommand(ConsoleSystem.Arg arg)
        {
            if (arg.Args == null || arg.Args.Length < 1) { Puts("Usage: voicemonitor.setkey YOUR_KEY"); return; }
            _config.ApiKey = arg.Args[0];
            Interface.Oxide.DataFileSystem.WriteObject("VoiceMonitorKey", _config);
            Puts("[VoiceMonitor] Deepgram API key saved.");
        }

        private void OnTick()
        {
            if (string.IsNullOrEmpty(_config.ApiKey)) return;
            float now = UnityEngine.Time.realtimeSinceStartup;
            foreach (var uid in new List<ulong>(_voiceBuffer.Keys))
            {
                if (_processing.Contains(uid)) continue;
                if (!_voiceBuffer.ContainsKey(uid) || _voiceBuffer[uid].Count < MIN_CHUNKS) continue;
                float lastPacket = _lastSendTime.ContainsKey(uid) ? _lastSendTime[uid] : now;
                // Send if we've been silent for 1 second (natural pause) or buffer is 4s old
                bool silenced = (now - lastPacket) > SILENCE_THRESHOLD;
                bool buffered = _voiceBuffer[uid].Count >= MIN_CHUNKS * 4;
                if (silenced || buffered)
                {
                    var player = BasePlayer.FindByID(uid);
                    if (player == null) { _voiceBuffer.Remove(uid); continue; }
                    var chunks = _voiceBuffer[uid].ToArray();
                    _voiceBuffer[uid].Clear();
                    _processing.Add(uid);
                    ServerMgr.Instance.StartCoroutine(TranscribeCoroutine(uid, player.displayName, player.UserIDString, chunks));
                }
            }
        }

        private void OnPlayerVoice(BasePlayer player, byte[] data)
        {
            if (player == null || data == null || data.Length == 0) return;
            if (string.IsNullOrEmpty(_config.ApiKey)) return;
            if (_processing.Contains(player.userID)) return;

            ulong uid = player.userID;
            if (!_voiceBuffer.ContainsKey(uid)) _voiceBuffer[uid] = new List<byte[]>();
            if (!_lastSendTime.ContainsKey(uid)) _lastSendTime[uid] = UnityEngine.Time.realtimeSinceStartup;
            _voiceBuffer[uid].Add((byte[])data.Clone());
            _lastSendTime[uid] = UnityEngine.Time.realtimeSinceStartup; // reset on each packet

            // Sending handled by OnTick for silence detection
        }

        private IEnumerator TranscribeCoroutine(ulong uid, string username, string steamId, byte[][] chunks)
        {
            var frames = ParseSteamVoice(chunks);
            Puts("[VoiceMonitor] Parsed " + frames.Count + " Opus frames");
            if (frames.Count == 0) { _processing.Remove(uid); yield break; }

            byte[] ogg = BuildOggOpus(frames);
            // Calculate average frame size - low average = mostly silence
            int totalBytes = 0;
            foreach (var f in frames) totalBytes += f.Length;
            int avgSize = frames.Count > 0 ? totalBytes / frames.Count : 0;
            Puts("[VoiceMonitor] Frames: " + frames.Count + " avg size: " + avgSize + " bytes");
            // Skip if average frame size is too small - means mostly silence
            if (avgSize < 20) { Puts("[VoiceMonitor] Skipping - mostly silence"); _processing.Remove(uid); yield break; }
            Puts("[VoiceMonitor] OGG: " + ogg.Length + " bytes → Deepgram...");

            // Send to Deepgram Nova-3 — does NOT censor slurs
            // profanity=false means slurs transcribed as-is
            string dgUrl = "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&detect_language=true&profanity_filter=false";

            var req = new UnityWebRequest(dgUrl, "POST");
            req.uploadHandler = new UploadHandlerRaw(ogg);
            req.downloadHandler = new DownloadHandlerBuffer();
            req.SetRequestHeader("Authorization", "Token " + _config.ApiKey);
            req.SetRequestHeader("Content-Type", "audio/ogg; codecs=opus");

            yield return req.SendWebRequest();
            _processing.Remove(uid);

            if (req.responseCode != 200) { Puts("[VoiceMonitor] Deepgram error " + req.responseCode + ": " + req.downloadHandler.text); yield break; }

            try
            {
                var json = JObject.Parse(req.downloadHandler.text);
                string transcript = json["results"]?["channels"]?[0]?["alternatives"]?[0]?["transcript"]?.Value<string>() ?? "";
                if (string.IsNullOrWhiteSpace(transcript)) { Puts("[VoiceMonitor] Empty transcript — raw: " + req.downloadHandler.text.Substring(0, Math.Min(200, req.downloadHandler.text.Length))); yield break; }
                Puts("[VoiceMonitor] ✅ Transcript: \"" + transcript + "\"");
                Puts("[VOICETRANSCRIPT] " + steamId + " " + username + " " + transcript);
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
