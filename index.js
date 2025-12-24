const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const mkdirp = require('mkdirp');
const ffmpeg = require('fluent-ffmpeg');
const { exec } = require('child_process');

const app = express();
app.use(express.json({ limit: '50mb' }));

const TMP_ROOT = path.join(__dirname, 'tmp');
mkdirp.sync(TMP_ROOT);
app.use('/tmp', express.static(TMP_ROOT));

// Respond to .well-known requests (some devtools/extensions probe this)
app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => {
  return res.json({ ok: true });
});

// Generic handler for other .well-known paths to avoid 404 noise
app.get('/.well-known/*', (req, res) => {
  return res.status(200).json({ ok: true, path: req.path });
});

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    fetch(url).then(res => {
      if (!res.ok) return reject(new Error('Failed to download ' + url + ' status ' + res.status));
      const fileStream = fs.createWriteStream(dest);
      res.body.pipe(fileStream);
      res.body.on('error', reject);
      fileStream.on('finish', () => resolve(dest));
    }).catch(reject);
  });
}

function run(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, opts, (err, stdout, stderr) => {
      if (err) return reject({ err, stderr, stdout });
      resolve({ stdout, stderr });
    });
  });
}

// YouTube resumable upload helpers
async function startResumableUpload(accessToken, metadata) {
  const url = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8'
    },
    body: JSON.stringify(metadata)
  });
  if (![200,201].includes(res.status)) {
    const txt = await res.text();
    throw new Error('resumable init failed: ' + res.status + ' ' + txt);
  }
  const uploadUrl = res.headers.get('location');
  if (!uploadUrl) throw new Error('No upload URL returned');
  return uploadUrl;
}

async function uploadFileToUrl(uploadUrl, filePath) {
  const stat = fs.statSync(filePath);
  const stream = fs.createReadStream(filePath);
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': stat.size
    },
    body: stream
  });
  const text = await res.text();
  if (![200,201].includes(res.status)) throw new Error('upload failed: ' + res.status + ' ' + text);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function makeSegmentFromImage(imgPath, outPath, duration = 3) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(imgPath)
      .loop(1)
      .outputOptions(['-c:v libx264', `-t ${duration}`, '-pix_fmt yuv420p', '-vf scale=720:1280'])
      .save(outPath)
      .on('end', () => resolve(outPath))
      .on('error', reject);
  });
}

app.post('/assemble', async (req, res) => {
  // expected body: { images: [url,...], audio: url, durationPerImage?: number }
  try {
    const { images = [], audio, durationPerImage = 3 } = req.body;
    if (!images.length) return res.status(400).json({ error: 'images array required' });
    if (!audio) return res.status(400).json({ error: 'audio url required' });

    const id = uuidv4();
    const dir = path.join(TMP_ROOT, id);
    mkdirp.sync(dir);

    // download images
    const imagePaths = [];
    for (let i = 0; i < images.length; i++) {
      const url = images[i];
      const ext = path.extname(new URL(url).pathname).split('?')[0] || '.jpg';
      const dest = path.join(dir, `img_${i}${ext}`);
      await downloadFile(url, dest);
      imagePaths.push(dest);
    }

    // download audio
    const audioExt = path.extname(new URL(audio).pathname).split('?')[0] || '.mp3';
    const audioPath = path.join(dir, `audio${audioExt}`);
    await downloadFile(audio, audioPath);

    // create segments from images
    const segmentPaths = [];
    for (let i = 0; i < imagePaths.length; i++) {
      const seg = path.join(dir, `seg_${i}.mp4`);
      // await segment creation
      await makeSegmentFromImage(imagePaths[i], seg, durationPerImage);
      segmentPaths.push(seg);
    }

    // create filelist for concat
    const listPath = path.join(dir, 'filelist.txt');
    const listContent = segmentPaths.map(p => `file '${p.replace(/\\/g, '\\\\')}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    // final output path
    const outputPath = path.join(dir, 'output.mp4');

    // run concat and add audio (using -safe 0 because we use absolute paths)
    const cmd = `ffmpeg -y -f concat -safe 0 -i "${listPath}" -i "${audioPath}" -c:v libx264 -c:a aac -shortest "${outputPath}"`;
    await run(cmd, { maxBuffer: 1024 * 1024 * 10 });

    // return public URL to the file
    const fileUrl = `${req.protocol}://${req.get('host')}/tmp/${id}/output.mp4`;
    return res.json({ id, output: outputPath, url: fileUrl });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'assembly_failed', detail: err && err.stderr ? err.stderr : err });
  }
});

// Cleanup utilities: remove tmp folders older than threshold
function cleanupOldTmp(thresholdMinutes = 60) {
  const now = Date.now();
  const threshold = thresholdMinutes * 60 * 1000;
  if (!fs.existsSync(TMP_ROOT)) return 0;
  const entries = fs.readdirSync(TMP_ROOT);
  let removed = 0;
  for (const name of entries) {
    const p = path.join(TMP_ROOT, name);
    try {
      const stats = fs.statSync(p);
      const mtime = stats.mtimeMs || stats.ctimeMs || stats.birthtimeMs || 0;
      if (now - mtime > threshold) {
        // remove recursively
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      }
    } catch (e) {
      // ignore
    }
  }
  return removed;
}

// Expose manual cleanup endpoint (protected in production)
app.get('/cleanup', (req, res) => {
  try {
    const removed = cleanupOldTmp(60);
    res.json({ removed });
  } catch (err) {
    res.status(500).json({ error: 'cleanup_failed', detail: String(err) });
  }
});

// Upload assembled video to YouTube using resumable upload
app.post('/upload', async (req, res) => {
  // expected body: { videoUrl, accessToken, title, description, tags }
  try {
    const { videoUrl, accessToken, title = 'Short Video', description = '', tags = [] } = req.body;
    if (!videoUrl) return res.status(400).json({ error: 'videoUrl required' });
    if (!accessToken) return res.status(400).json({ error: 'accessToken required' });

    const id = uuidv4();
    const uploadDir = path.join(TMP_ROOT, `upload_${id}`);
    mkdirp.sync(uploadDir);
    const dest = path.join(uploadDir, 'video.mp4');

    // download video
    await downloadFile(videoUrl, dest);

    // prepare metadata
    const metadata = {
      snippet: { title, description, tags },
      status: { privacyStatus: 'public' }
    };

    // init resumable session
    const uploadUrl = await startResumableUpload(accessToken, metadata);

    // upload file
    const result = await uploadFileToUrl(uploadUrl, dest);

    // return result
    return res.json({ success: true, result });
  } catch (err) {
    console.error('upload error', err);
    return res.status(500).json({ error: 'upload_failed', detail: err && err.message ? err.message : err });
  }
});

// Simple local duplication tracker (file-based)
const PUBLISHED_DB = path.join(__dirname, 'published.json');
function readPublished() {
  try {
    if (!fs.existsSync(PUBLISHED_DB)) return [];
    const raw = fs.readFileSync(PUBLISHED_DB, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (e) { return []; }
}
function writePublished(arr) {
  fs.writeFileSync(PUBLISHED_DB, JSON.stringify(arr, null, 2));
}

// Check duplicate: GET /check?key=KEYWORD
app.get('/check', (req, res) => {
  try {
    const key = (req.query.key || '').toString().trim().toLowerCase();
    if (!key) return res.status(400).json({ error: 'key required' });
    const db = readPublished();
    const found = db.find(e => e.key === key);
    return res.json({ exists: !!found, record: found || null });
  } catch (err) {
    return res.status(500).json({ error: 'check_failed', detail: String(err) });
  }
});

// Record published: POST /record { key, title, url, platform }
app.post('/record', (req, res) => {
  try {
    const { key, title, url, platform } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key required' });
    const k = key.toString().trim().toLowerCase();
    const db = readPublished();
    const now = new Date().toISOString();
    const rec = { key: k, title: title || '', url: url || '', platform: platform || 'unknown', publishedAt: now };
    db.push(rec);
    writePublished(db);
    return res.json({ success: true, record: rec });
  } catch (err) {
    return res.status(500).json({ error: 'record_failed', detail: String(err) });
  }
});

// Run periodic cleanup every 30 minutes
setInterval(() => {
  try {
    const removed = cleanupOldTmp(60);
    if (removed > 0) console.log(`cleanup removed ${removed} tmp folders`);
  } catch (e) {
    console.error('cleanup error', e);
  }
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ffmpeg assembler listening on port ${PORT}`));
