const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const mkdirp = require('mkdirp');

async function downloadToFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('download failed: ' + res.status);
  const stream = fs.createWriteStream(dest);
  await new Promise((resolve, reject) => {
    res.body.pipe(stream);
    res.body.on('error', reject);
    stream.on('finish', resolve);
  });
  return dest;
}

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
  if (![200,201].includes(res.status) && !res.headers.get('location')) {
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

async function main() {
  // Accept args or env
  const argv = require('minimist')(process.argv.slice(2));
  const ACCESS_TOKEN = argv.access_token || process.env.ACCESS_TOKEN;
  const VIDEO_URL = argv.video_url || process.env.VIDEO_URL;
  const TITLE = argv.title || process.env.TITLE || 'Short Video';
  const DESCRIPTION = argv.description || process.env.DESCRIPTION || '';
  const TAGS = (argv.tags || process.env.TAGS || '').split(',').map(s => s.trim()).filter(Boolean);

  if (!ACCESS_TOKEN) throw new Error('ACCESS_TOKEN required');
  if (!VIDEO_URL) throw new Error('VIDEO_URL required');

  const tmpRoot = path.join(__dirname, 'tmp_upload');
  mkdirp.sync(tmpRoot);
  const id = uuidv4();
  const dest = path.join(tmpRoot, id + '.mp4');

  console.log('Downloading video from', VIDEO_URL);
  await downloadToFile(VIDEO_URL, dest);
  console.log('Downloaded to', dest);

  const metadata = {
    snippet: {
      title: TITLE,
      description: DESCRIPTION,
      tags: TAGS
    },
    status: {
      privacyStatus: 'public'
    }
  };

  console.log('Initializing resumable upload');
  const uploadUrl = await startResumableUpload(ACCESS_TOKEN, metadata);
  console.log('Upload URL:', uploadUrl);

  console.log('Uploading file...');
  const result = await uploadFileToUrl(uploadUrl, dest);
  console.log('Upload result:', result);
  process.stdout.write(JSON.stringify(result));
}

main().catch(e => {
  console.error('Error:', e && e.message ? e.message : e);
  process.exit(1);
});
