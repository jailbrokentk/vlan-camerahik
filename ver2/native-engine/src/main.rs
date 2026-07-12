use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use futures_util::{SinkExt, StreamExt};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::Message;
use url::Url;

#[derive(Clone, Serialize, Deserialize, Debug)]
struct CameraConfig {
    url: String,
    qos: Option<u8>,
}

#[tokio::main]
async fn main() {
    println!("[Rust Media Engine] Starting up on port 3002...");

    let addr = "127.0.0.1:3002";
    let listener = TcpListener::bind(addr).await.expect("Failed to bind TCP listener");
    println!("[Rust Media Engine] Listening on ws://{}", addr);

    let active_streams: Arc<tokio::sync::Mutex<HashMap<String, broadcast::Sender<Message>>>> =
        Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    while let Ok((stream, peer_addr)) = listener.accept().await {
        let active_streams_clone = active_streams.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, peer_addr, active_streams_clone).await {
                let err_str = e.to_string();
                // Filter out common WebSocket handshake protocols errors (e.g. scanner, health check, normal refresh abort)
                if !err_str.contains("MissingConnectionUpgradeHeader") 
                    && !err_str.contains("ConnectionClosed")
                    && !err_str.contains("connection reset") {
                    eprintln!("[Rust Media Engine] Error handling peer {}: {}", peer_addr, err_str);
                }
            }
        });
    }
}

async fn handle_connection(
    tcp_stream: TcpStream,
    peer_addr: SocketAddr,
    active_streams: Arc<tokio::sync::Mutex<HashMap<String, broadcast::Sender<Message>>>>,
) -> Result<(), Box<dyn std::error::Error>> {
    println!("[Rust Media Engine] New connection from {}", peer_addr);

    let mut rtsp_url_query = String::new();

    let ws_stream = accept_hdr_async(tcp_stream, |req: &Request, res: Response| {
        let uri = req.uri();
        if let Some(query) = uri.query() {
            for part in query.split('&') {
                let kv: Vec<&str> = part.split('=').collect();
                if kv.len() == 2 && kv[0] == "url" {
                    rtsp_url_query = percent_encoding::percent_decode_str(kv[1])
                        .decode_utf8_lossy()
                        .into_owned();
                }
            }
        }
        Ok(res)
    }).await?;

    if rtsp_url_query.is_empty() {
        eprintln!("[Rust Media Engine] Missing RTSP URL in connection parameters");
        return Ok(());
    }

    println!("[Rust Media Engine] Peer requested RTSP URL: {}", rtsp_url_query);

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    // Get or create stream manager
    let mut streams = active_streams.lock().await;
    let rx = if let Some(tx) = streams.get(&rtsp_url_query) {
        println!("[Rust Media Engine] Subscribing to existing stream for: {}", rtsp_url_query);
        tx.subscribe()
    } else {
        println!("[Rust Media Engine] Creating new stream session for: {}", rtsp_url_query);
        let (tx, rx) = broadcast::channel(1024); // Larger buffer to prevent lag
        streams.insert(rtsp_url_query.clone(), tx.clone());

        let rtsp_url_clone = rtsp_url_query.clone();
        let tx_clone = tx.clone();
        let active_streams_clone = active_streams.clone();
        tokio::spawn(async move {
            // Retry loop for RTSP connection
            let mut retry_count = 0;
            loop {
                let should_retry = match run_rtsp_client(rtsp_url_clone.clone(), tx_clone.clone()).await {
                    Ok(_) => {
                        println!("[Rust Media Engine] RTSP stream ended normally for: {}", rtsp_url_clone);
                        false
                    }
                    Err(e) => {
                        retry_count += 1;
                        eprintln!("[Rust Media Engine] RTSP Client error (attempt {}): {:?}", retry_count, e);
                        retry_count < 5 && tx_clone.receiver_count() > 0
                    }
                };
                // Error is now dropped here (out of scope)
                if !should_retry {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            let mut streams = active_streams_clone.lock().await;
            streams.remove(&rtsp_url_clone);
            println!("[Rust Media Engine] Stream session closed for: {}", rtsp_url_clone);
        });

        rx
    };
    drop(streams);

    // Forward messages from broadcast channel to WebSocket client
    let mut rx_stream = rx;
    tokio::spawn(async move {
        loop {
            match rx_stream.recv().await {
                Ok(msg) => {
                    if ws_sender.send(msg).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    eprintln!("[Rust Media Engine] Broadcast lagged by {} frames for {}", skipped, peer_addr);
                    continue; // Skip and continue, do NOT break!
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
        println!("[Rust Media Engine] Peer disconnected: {}", peer_addr);
    });

    // Keep WebSocket alive and listen for client close
    while let Some(result) = ws_receiver.next().await {
        match result {
            Ok(msg) => {
                if msg.is_close() {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    Ok(())
}

// ── RTSP Digest Auth State ──────────────────────────────────────────────────

struct DigestAuth {
    realm: String,
    nonce: String,
    username: String,
    password: String,
}

impl DigestAuth {
    fn new(username: &str, password: &str) -> Self {
        DigestAuth {
            realm: String::new(),
            nonce: String::new(),
            username: username.to_string(),
            password: password.to_string(),
        }
    }

    fn update_from_headers(&mut self, headers: &HashMap<String, String>) {
        let auth_header = headers
            .iter()
            .find(|(k, _)| k.to_lowercase() == "www-authenticate")
            .map(|(_, v)| v)
            .cloned()
            .unwrap_or_default();

        if auth_header.starts_with("Digest ") {
            let challenge = &auth_header[7..];
            for item in challenge.split(',') {
                let kv: Vec<&str> = item.splitn(2, '=').collect();
                if kv.len() == 2 {
                    let k = kv[0].trim().to_lowercase();
                    let v = kv[1].trim().replace('"', "");
                    match k.as_str() {
                        "realm" => self.realm = v,
                        "nonce" => self.nonce = v,
                        _ => {}
                    }
                }
            }
        }
    }

    fn make_header(&self, method: &str, uri: &str) -> String {
        if self.nonce.is_empty() {
            // No digest challenge yet, return empty
            return String::new();
        }
        let ha1 = format!("{:x}", Md5::digest(
            format!("{}:{}:{}", self.username, self.realm, self.password).as_bytes()
        ));
        let ha2 = format!("{:x}", Md5::digest(
            format!("{}:{}", method, uri).as_bytes()
        ));
        let response = format!("{:x}", Md5::digest(
            format!("{}:{}:{}", ha1, self.nonce, ha2).as_bytes()
        ));

        format!(
            "Digest username=\"{}\", realm=\"{}\", nonce=\"{}\", uri=\"{}\", response=\"{}\"",
            self.username, self.realm, self.nonce, uri, response
        )
    }
}

async fn run_rtsp_client(
    rtsp_url: String,
    tx: broadcast::Sender<Message>,
) -> Result<(), Box<dyn std::error::Error>> {
    let url = Url::parse(&rtsp_url)?;
    let host = url.host_str().ok_or("Missing host in RTSP URL")?;
    let port = url.port().unwrap_or(554);
    // URL::username() and URL::password() return percent-decoded values
    let username = percent_encoding::percent_decode_str(url.username())
        .decode_utf8_lossy()
        .into_owned();
    let password = percent_encoding::percent_decode_str(url.password().unwrap_or(""))
        .decode_utf8_lossy()
        .into_owned();

    // Build clean RTSP URL without credentials for RTSP commands
    let clean_url = format!("rtsp://{}:{}{}", host, port, url.path());

    println!("[RTSP Client] Connecting to {}:{} (user: {})", host, port, username);
    let mut stream = match tokio::time::timeout(
        Duration::from_secs(3),
        TcpStream::connect(format!("{}:{}", host, port))
    ).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(format!("TCP Connection error: {}", e).into()),
        Err(_) => return Err("TCP Connection timeout (3s)".into()),
    };

    let mut cseq: u32 = 1;
    let mut session_id = String::new();
    let mut video_track = String::new();
    let mut auth = DigestAuth::new(&username, &password);

    // 1. OPTIONS request (no auth needed)
    let req = format!(
        "OPTIONS {} RTSP/1.0\r\nCSeq: {}\r\nUser-Agent: RustMediaEngine/1.0\r\n\r\n",
        clean_url, cseq
    );
    stream.write_all(req.as_bytes()).await?;
    let res = read_rtsp_response(&mut stream).await?;
    println!("[RTSP Client] OPTIONS response: {}", res.status);
    cseq += 1;

    // 2. DESCRIBE request (may need auth)
    let req = format!(
        "DESCRIBE {} RTSP/1.0\r\nCSeq: {}\r\nAccept: application/sdp\r\nUser-Agent: RustMediaEngine/1.0\r\n\r\n",
        clean_url, cseq
    );
    stream.write_all(req.as_bytes()).await?;
    let res = read_rtsp_response(&mut stream).await?;
    cseq += 1;

    let sdp_body = if res.status == 401 {
        println!("[RTSP Client] 401 Unauthorized. Authenticating with Digest...");
        auth.update_from_headers(&res.headers);
        let auth_header = auth.make_header("DESCRIBE", &clean_url);
        let req = format!(
            "DESCRIBE {} RTSP/1.0\r\nCSeq: {}\r\nAccept: application/sdp\r\nAuthorization: {}\r\nUser-Agent: RustMediaEngine/1.0\r\n\r\n",
            clean_url, cseq, auth_header
        );
        stream.write_all(req.as_bytes()).await?;
        let res2 = read_rtsp_response(&mut stream).await?;
        cseq += 1;
        if res2.status != 200 {
            return Err(format!("RTSP Auth failed: {} (check username/password)", res2.status).into());
        }
        // Update auth from successful response in case nonce changed
        if let Some(_) = res2.headers.iter().find(|(k, _)| k.to_lowercase() == "www-authenticate") {
            auth.update_from_headers(&res2.headers);
        }
        res2.body
    } else if res.status == 200 {
        res.body
    } else {
        return Err(format!("RTSP DESCRIBE failed: {}", res.status).into());
    };

    println!("[RTSP Client] SDP:\n{}", sdp_body);

    // Parse SDP to find video track
    let mut sprop_parameter_sets = String::new();
    let mut sprop_vps = String::new();
    let mut sprop_sps = String::new();
    let mut sprop_pps = String::new();
    let mut in_video_media = false;
    let mut _found_h264 = false;
    let mut is_h265 = false;

    for line in sdp_body.lines() {
        let line = line.trim();

        // Detect video media section
        if line.starts_with("m=video") {
            in_video_media = true;
            continue;
        }
        if line.starts_with("m=") && !line.starts_with("m=video") {
            in_video_media = false;
            continue;
        }

        if in_video_media {
            // Look for H264/H265 rtpmap
            if line.contains("H264") || line.contains("h264") {
                _found_h264 = true;
            }
            if line.contains("H265") || line.contains("h265") || line.contains("HEVC") || line.contains("hevc") {
                is_h265 = true;
            }

            // Extract control URL for the video track
            if line.starts_with("a=control:") {
                let track = line.trim_start_matches("a=control:").trim();
                if !track.is_empty() && track != "*" {
                    video_track = track.to_string();
                }
            }

            // Extract SPS/PPS from fmtp
            if line.contains("sprop-parameter-sets=") {
                if let Some(pos) = line.find("sprop-parameter-sets=") {
                    let rest = &line[pos + 21..];
                    // Value ends at ';' or end of line
                    let value = rest.split(';').next().unwrap_or("").trim();
                    if !value.is_empty() {
                        sprop_parameter_sets = value.to_string();
                    }
                }
            }
            // For H.265: parse sprop-vps, sprop-sps, sprop-pps
            if line.contains("sprop-vps=") {
                if let Some(pos) = line.find("sprop-vps=") {
                    let rest = &line[pos + 10..];
                    let value = rest.split(';').next().unwrap_or("").trim();
                    sprop_vps = value.to_string();
                }
            }
            if line.contains("sprop-sps=") {
                if let Some(pos) = line.find("sprop-sps=") {
                    let rest = &line[pos + 10..];
                    let value = rest.split(';').next().unwrap_or("").trim();
                    sprop_sps = value.to_string();
                }
            }
            if line.contains("sprop-pps=") {
                if let Some(pos) = line.find("sprop-pps=") {
                    let rest = &line[pos + 10..];
                    let value = rest.split(';').next().unwrap_or("").trim();
                    sprop_pps = value.to_string();
                }
            }
        }
    }

    if video_track.is_empty() {
        // Fallback: search globally
        for line in sdp_body.lines() {
            let line = line.trim();
            if line.starts_with("a=control:") {
                let track = line.trim_start_matches("a=control:").trim();
                if track.contains("trackID") || track.contains("track") || track.contains("video") || track.contains("streamid") {
                    video_track = track.to_string();
                    break;
                }
            }
        }
    }

    if video_track.is_empty() {
        video_track = "trackID=1".to_string();
    }

    // Build the SETUP URL
    let setup_url = if video_track.starts_with("rtsp://") {
        video_track.clone()
    } else {
        let base = clean_url.trim_end_matches('/');
        if video_track.starts_with('/') {
            format!("rtsp://{}:{}{}", host, port, video_track)
        } else {
            format!("{}/{}", base, video_track)
        }
    };

    println!("[RTSP Client] Video track: {}, Setup URL: {}, H265: {}", video_track, setup_url, is_h265);

    // Send SPS/PPS/VPS from SDP so WebCodecs can configure immediately
    if is_h265 {
        for v in &[&sprop_vps, &sprop_sps, &sprop_pps] {
            if !v.is_empty() {
                if let Ok(decoded) = base64_decode(v.trim()) {
                    let mut frame = vec![0u8, 0, 0, 1];
                    frame.extend_from_slice(&decoded);
                    let _ = tx.send(Message::Binary(frame));
                }
            }
        }
    } else {
        if !sprop_parameter_sets.is_empty() {
            println!("[RTSP Client] Found SPS/PPS: {}", sprop_parameter_sets);
            let nals: Vec<&str> = sprop_parameter_sets.split(',').collect();
            for nal in nals {
                if let Ok(decoded) = base64_decode(nal.trim()) {
                    let mut frame = vec![0u8, 0, 0, 1];
                    frame.extend_from_slice(&decoded);
                    let _ = tx.send(Message::Binary(frame));
                }
            }
        }
    }

    // 3. SETUP request
    let auth_header = auth.make_header("SETUP", &setup_url);
    let req = if auth_header.is_empty() {
        format!(
            "SETUP {} RTSP/1.0\r\nCSeq: {}\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\nUser-Agent: RustMediaEngine/1.0\r\n\r\n",
            setup_url, cseq
        )
    } else {
        format!(
            "SETUP {} RTSP/1.0\r\nCSeq: {}\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\nAuthorization: {}\r\nUser-Agent: RustMediaEngine/1.0\r\n\r\n",
            setup_url, cseq, auth_header
        )
    };
    stream.write_all(req.as_bytes()).await?;
    let res = read_rtsp_response(&mut stream).await?;
    if res.status == 401 {
        // Re-authenticate for SETUP
        auth.update_from_headers(&res.headers);
        cseq += 1;
        let auth_header = auth.make_header("SETUP", &setup_url);
        let req = format!(
            "SETUP {} RTSP/1.0\r\nCSeq: {}\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\nAuthorization: {}\r\nUser-Agent: RustMediaEngine/1.0\r\n\r\n",
            setup_url, cseq, auth_header
        );
        stream.write_all(req.as_bytes()).await?;
        let res2 = read_rtsp_response(&mut stream).await?;
        if res2.status != 200 {
            return Err(format!("RTSP SETUP auth failed: {}", res2.status).into());
        }
        // Parse session from re-authed response
        for (k, v) in &res2.headers {
            if k.to_lowercase() == "session" {
                session_id = v.split(';').next().unwrap_or("").trim().to_string();
            }
        }
    } else if res.status != 200 {
        return Err(format!("RTSP SETUP failed: {}", res.status).into());
    } else {
        for (k, v) in &res.headers {
            if k.to_lowercase() == "session" {
                session_id = v.split(';').next().unwrap_or("").trim().to_string();
            }
        }
    }
    cseq += 1;

    println!("[RTSP Client] Session established: {}", session_id);

    // 4. PLAY request
    let auth_header = auth.make_header("PLAY", &clean_url);
    let req = if auth_header.is_empty() {
        format!(
            "PLAY {} RTSP/1.0\r\nCSeq: {}\r\nSession: {}\r\nUser-Agent: RustMediaEngine/1.0\r\n\r\n",
            clean_url, cseq, session_id
        )
    } else {
        format!(
            "PLAY {} RTSP/1.0\r\nCSeq: {}\r\nSession: {}\r\nAuthorization: {}\r\nUser-Agent: RustMediaEngine/1.0\r\n\r\n",
            clean_url, cseq, session_id, auth_header
        )
    };
    stream.write_all(req.as_bytes()).await?;
    let res = read_rtsp_response(&mut stream).await?;
    if res.status == 401 {
        // Re-authenticate for PLAY
        auth.update_from_headers(&res.headers);
        cseq += 1;
        let auth_header = auth.make_header("PLAY", &clean_url);
        let req = format!(
            "PLAY {} RTSP/1.0\r\nCSeq: {}\r\nSession: {}\r\nAuthorization: {}\r\nUser-Agent: RustMediaEngine/1.0\r\n\r\n",
            clean_url, cseq, session_id, auth_header
        );
        stream.write_all(req.as_bytes()).await?;
        let res2 = read_rtsp_response(&mut stream).await?;
        if res2.status != 200 {
            return Err(format!("RTSP PLAY auth failed: {}", res2.status).into());
        }
    } else if res.status != 200 {
        return Err(format!("RTSP PLAY failed: {}", res.status).into());
    }

    println!("[RTSP Client] Streaming started. Reading interleaved RTP packets...");

    // 5. Interleaved RTP read loop
    let mut h264_frame = Vec::with_capacity(512 * 1024); // Pre-allocate 512KB
    let mut last_seq: u16 = 0;
    let mut last_telemetry = Instant::now();
    let mut frames_received: u64 = 0;
    let mut frames_dropped: u64 = 0;
    let mut total_bytes: u64 = 0;

    // Keep-alive timer
    let mut last_keepalive = Instant::now();

    loop {
        // Check if any subscribers remain
        if tx.receiver_count() == 0 {
            println!("[RTSP Client] No more subscribers. Closing stream.");
            break;
        }

        // Send RTSP keepalive every 30 seconds
        if last_keepalive.elapsed() >= Duration::from_secs(30) {
            let keepalive = format!(
                "GET_PARAMETER {} RTSP/1.0\r\nCSeq: {}\r\nSession: {}\r\nUser-Agent: RustMediaEngine/1.0\r\n\r\n",
                clean_url, cseq, session_id
            );
            let _ = stream.write_all(keepalive.as_bytes()).await;
            cseq += 1;
            last_keepalive = Instant::now();
        }

        // Telemetry every 10 seconds
        if last_telemetry.elapsed() >= Duration::from_secs(10) {
            let elapsed = last_telemetry.elapsed().as_secs_f32();
            println!(
                "[Telemetry] FPS: {:.1} | Received: {} | Dropped: {} | Bitrate: {:.1} Mbps | Subscribers: {}",
                frames_received as f32 / elapsed,
                frames_received,
                frames_dropped,
                (total_bytes as f64 * 8.0) / (elapsed as f64 * 1_000_000.0),
                tx.receiver_count()
            );
            frames_received = 0;
            frames_dropped = 0;
            total_bytes = 0;
            last_telemetry = Instant::now();
        }

        // Read interleaved header ($ + channel + 2-byte length)
        let mut header = [0u8; 4];
        match tokio::time::timeout(Duration::from_secs(10), stream.read_exact(&mut header)).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => {
                return Err(format!("Stream read error: {}", e).into());
            }
            Err(_) => {
                // Timeout - send keepalive and continue
                eprintln!("[RTSP Client] Read timeout, sending keepalive...");
                continue;
            }
        }

        if header[0] == b'$' {
            let channel = header[1];
            let len = ((header[2] as usize) << 8) | (header[3] as usize);

            if len > 65535 {
                eprintln!("[RTSP Client] Invalid packet length: {}, skipping", len);
                continue;
            }

            let mut packet = vec![0u8; len];
            stream.read_exact(&mut packet).await?;

            if channel == 0 {
                // RTP video packets
                if packet.len() < 12 {
                    continue;
                }

                total_bytes += packet.len() as u64;

                // Parse RTP header
                let seq = ((packet[2] as u16) << 8) | (packet[3] as u16);
                let _marker = (packet[1] & 0x80) != 0; // Marker bit = end of frame

                if last_seq != 0 {
                    let expected = last_seq.wrapping_add(1);
                    if seq != expected {
                        eprintln!("[RTSP Client] Packet loss: expected seq {}, got {}", expected, seq);
                    }
                }
                last_seq = seq;

                // RTP Payload
                let cc = (packet[0] & 0x0F) as usize; // CSRC count
                let payload_offset = 12 + cc * 4;
                if payload_offset >= packet.len() {
                    continue;
                }

                // Check for RTP header extension
                let has_extension = (packet[0] & 0x10) != 0;
                let rtp_payload = if has_extension && payload_offset + 4 <= packet.len() {
                    let ext_len = ((packet[payload_offset + 2] as usize) << 8) | (packet[payload_offset + 3] as usize);
                    let ext_total = 4 + ext_len * 4;
                    &packet[payload_offset + ext_total..]
                } else {
                    &packet[payload_offset..]
                };

                if rtp_payload.is_empty() {
                    continue;
                }

                // Parse H.264 or H.265 NAL unit
                if is_h265 {
                    if rtp_payload.len() < 2 {
                        continue;
                    }
                    let nal_type = (rtp_payload[0] >> 1) & 0x3F;

                    if nal_type >= 0 && nal_type <= 47 {
                        // Single NAL unit packet
                        h264_frame.clear();
                        h264_frame.extend_from_slice(&[0, 0, 0, 1]);
                        h264_frame.extend_from_slice(rtp_payload);

                        let _ = tx.send(Message::Binary(h264_frame.clone()));
                        frames_received += 1;
                    } else if nal_type == 49 {
                        // Fragmentation Unit (FU)
                        if rtp_payload.len() < 3 {
                            continue;
                        }
                        let fu_header = rtp_payload[2];
                        let start_bit = (fu_header & 0x80) != 0;
                        let end_bit = (fu_header & 0x40) != 0;
                        let inner_nal_type = fu_header & 0x3F;

                        if start_bit {
                            h264_frame.clear();
                            h264_frame.extend_from_slice(&[0, 0, 0, 1]);
                            // Reconstruct H.265 NAL Header
                            // Byte 0: forbidden (0) + Type (inner_nal_type) + LayerId (from original byte 0)
                            let byte0 = (rtp_payload[0] & 0x81) | (inner_nal_type << 1);
                            let byte1 = rtp_payload[1];
                            h264_frame.push(byte0);
                            h264_frame.push(byte1);
                        }
                        h264_frame.extend_from_slice(&rtp_payload[3..]);

                        if end_bit {
                            let _ = tx.send(Message::Binary(h264_frame.clone()));
                            frames_received += 1;
                        }
                    } else if nal_type == 48 {
                        // AP (Aggregation Packet)
                        let mut offset = 2; // Skip 2-byte AP header
                        while offset + 2 < rtp_payload.len() {
                            let nal_size = ((rtp_payload[offset] as usize) << 8) | (rtp_payload[offset + 1] as usize);
                            offset += 2;
                            if offset + nal_size > rtp_payload.len() {
                                break;
                            }
                            h264_frame.clear();
                            h264_frame.extend_from_slice(&[0, 0, 0, 1]);
                            h264_frame.extend_from_slice(&rtp_payload[offset..offset + nal_size]);

                            let _ = tx.send(Message::Binary(h264_frame.clone()));
                            frames_received += 1;
                            offset += nal_size;
                        }
                    }
                } else {
                    // H.264
                    let nal_header = rtp_payload[0];
                    let nal_type = nal_header & 0x1F;

                    if nal_type >= 1 && nal_type <= 23 {
                        // Single NAL unit packet
                        h264_frame.clear();
                        h264_frame.extend_from_slice(&[0, 0, 0, 1]);
                        h264_frame.extend_from_slice(rtp_payload);

                        let _ = tx.send(Message::Binary(h264_frame.clone()));
                        frames_received += 1;
                    } else if nal_type == 28 {
                        // FU-A fragmentation unit
                        if rtp_payload.len() < 2 {
                            continue;
                        }
                        let fu_header = rtp_payload[1];
                        let start_bit = (fu_header & 0x80) != 0;
                        let end_bit = (fu_header & 0x40) != 0;
                        let inner_nal_type = fu_header & 0x1F;

                        if start_bit {
                            h264_frame.clear();
                            h264_frame.extend_from_slice(&[0, 0, 0, 1]);
                            let reconstructed_header = (nal_header & 0xE0) | inner_nal_type;
                            h264_frame.push(reconstructed_header);
                        }
                        h264_frame.extend_from_slice(&rtp_payload[2..]);

                        if end_bit {
                            let _ = tx.send(Message::Binary(h264_frame.clone()));
                            frames_received += 1;
                        }
                    } else if nal_type == 24 {
                        // STAP-A: Single-time Aggregation Packet
                        let mut offset = 1;
                        while offset + 2 < rtp_payload.len() {
                            let nal_size = ((rtp_payload[offset] as usize) << 8) | (rtp_payload[offset + 1] as usize);
                            offset += 2;
                            if offset + nal_size > rtp_payload.len() {
                                break;
                            }
                            h264_frame.clear();
                            h264_frame.extend_from_slice(&[0, 0, 0, 1]);
                            h264_frame.extend_from_slice(&rtp_payload[offset..offset + nal_size]);

                            let _ = tx.send(Message::Binary(h264_frame.clone()));
                            frames_received += 1;
                            offset += nal_size;
                        }
                    }
                }
            }
            // channel 1 = RTCP, ignore
        } else if header[0] == b'R' {
            // This might be an RTSP response (to our keepalive). Read until \r\n\r\n
            let mut resp_buf = Vec::with_capacity(1024);
            resp_buf.extend_from_slice(&header);
            let mut temp = [0u8; 1];
            loop {
                match stream.read(&mut temp).await {
                    Ok(0) => break,
                    Ok(1) => {
                        resp_buf.push(temp[0]);
                        if resp_buf.len() >= 4 {
                            let last4 = &resp_buf[resp_buf.len()-4..];
                            if last4 == b"\r\n\r\n" {
                                break;
                            }
                        }
                        if resp_buf.len() > 4096 {
                            break; // Safety limit
                        }
                    }
                    _ => break,
                }
            }
            // Just consume the keepalive response, don't process it
        } else {
            // Unknown data, try to skip
            continue;
        }
    }

    // Send TEARDOWN
    let auth_header = auth.make_header("TEARDOWN", &clean_url);
    let req = format!(
        "TEARDOWN {} RTSP/1.0\r\nCSeq: {}\r\nSession: {}\r\nAuthorization: {}\r\nUser-Agent: RustMediaEngine/1.0\r\n\r\n",
        clean_url, cseq, session_id, auth_header
    );
    let _ = stream.write_all(req.as_bytes()).await;

    Ok(())
}

// ── RTSP Parser ─────────────────────────────────────────────────────────────

struct RtspResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

async fn read_rtsp_response(stream: &mut TcpStream) -> Result<RtspResponse, Box<dyn std::error::Error>> {
    let mut buf = vec![0u8; 16384]; // 16KB buffer (enough for SDP responses)
    let mut bytes_read = 0;

    // Read headers
    loop {
        let n = stream.read(&mut buf[bytes_read..]).await?;
        if n == 0 {
            return Err("Socket closed before RTSP response could be parsed".into());
        }
        bytes_read += n;

        // Expand buffer if needed
        if bytes_read >= buf.len() - 1024 {
            buf.resize(buf.len() * 2, 0);
        }

        if let Some(pos) = find_subsequence(&buf[..bytes_read], b"\r\n\r\n") {
            let header_part = String::from_utf8_lossy(&buf[..pos]);
            let mut lines = header_part.lines();

            // Status line
            let status_line = lines.next().ok_or("Empty RTSP response")?;
            let status_parts: Vec<&str> = status_line.split_whitespace().collect();
            if status_parts.len() < 2 {
                return Err("Invalid status line".into());
            }
            let status = status_parts[1].parse::<u16>()?;

            // Headers
            let mut headers = HashMap::new();
            for line in lines {
                if let Some(colon) = line.find(':') {
                    let k = line[..colon].trim().to_string();
                    let v = line[colon + 1..].trim().to_string();
                    headers.insert(k, v);
                }
            }

            // Content-Length
            let mut body_len = 0;
            for (k, v) in &headers {
                if k.to_lowercase() == "content-length" {
                    body_len = v.parse::<usize>().unwrap_or(0);
                }
            }

            // Read body
            let body_start = pos + 4;
            let mut body_buf = vec![0u8; body_len];
            let already = std::cmp::min(bytes_read - body_start, body_len);

            if already > 0 {
                body_buf[..already].copy_from_slice(&buf[body_start..body_start + already]);
            }

            let mut body_bytes_read = already;
            while body_bytes_read < body_len {
                let mut temp = vec![0u8; 4096];
                let n = stream.read(&mut temp).await?;
                if n == 0 {
                    break;
                }
                let to_copy = std::cmp::min(n, body_len - body_bytes_read);
                body_buf[body_bytes_read..body_bytes_read + to_copy].copy_from_slice(&temp[..to_copy]);
                body_bytes_read += to_copy;
            }

            let body = String::from_utf8_lossy(&body_buf).into_owned();
            return Ok(RtspResponse { status, headers, body });
        }
    }
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn base64_decode(input: &str) -> Result<Vec<u8>, base64::DecodeError> {
    use base64::{engine::general_purpose, Engine as _};
    general_purpose::STANDARD.decode(input.trim())
}
