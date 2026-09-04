const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseVideoUrl, safeHttpUrl } = require('../belfed-video-reviews.js');

test('parses YouTube watch and short links into privacy-enhanced embeds', () => {
  assert.deepEqual(parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), {
    provider: 'youtube',
    embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0',
  });
  assert.equal(
    parseVideoUrl('https://youtu.be/dQw4w9WgXcQ?t=10').embedUrl,
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0',
  );
});

test('parses Rutube and VK Video links', () => {
  assert.deepEqual(parseVideoUrl('https://rutube.ru/video/abc123/'), {
    provider: 'rutube',
    embedUrl: 'https://rutube.ru/play/embed/abc123/',
  });
  assert.deepEqual(parseVideoUrl('https://vkvideo.ru/video-12345_67890'), {
    provider: 'vk',
    embedUrl: 'https://vk.com/video_ext.php?oid=-12345&id=67890&hd=2',
  });
});

test('accepts only allowlisted explicit embeds and rejects unsafe schemes', () => {
  assert.equal(parseVideoUrl('https://video.example.com/watch/1', 'https://player.example.com/embed/1'), null);
  assert.equal(
    parseVideoUrl('https://youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ').embedUrl,
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
  );
  assert.equal(safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(safeHttpUrl('http://youtube.com/watch?v=dQw4w9WgXcQ'), '');
  assert.equal(parseVideoUrl('javascript:alert(1)'), null);
  assert.equal(parseVideoUrl('https://notyoutube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(parseVideoUrl('https://evilrutube.ru/video/abc123/'), null);
  assert.equal(parseVideoUrl('https://evilvk.com/video-12345_67890'), null);
  assert.equal(parseVideoUrl('', 'https://youtube.com/watch?v=dQw4w9WgXcQ'), null);
});

test('admin page uses a valid Supabase anon JWT payload', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin-video-reviews.html'), 'utf8');
  const match = html.match(/const SUPABASE_ANON='([^']+)'/);
  assert.ok(match, 'SUPABASE_ANON must be present');
  const payload = JSON.parse(Buffer.from(match[1].split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.iss, 'supabase');
  assert.equal(payload.ref, 'obujqvqqmyfcfflhqvud');
  assert.equal(payload.role, 'anon');
});
