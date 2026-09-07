const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePublicToken,
  getBaseUrl,
  parseDateInfo,
  normalizePhoto,
  sortPhotos
} = require('../src/icloud');
const { applyDateMarkers, inferAlbumOrderDateMarkers, applyInferredDateCards } = require('../src/timeline');

test('parses iCloud shared album token from a public URL fragment', () => {
  assert.equal(
    parsePublicToken('https://www.icloud.com/sharedalbum/#B0z5qXGF1ExampleToken'),
    'B0z5qXGF1ExampleToken'
  );
});

test('drops a selected-photo suffix from an iCloud shared album URL', () => {
  assert.equal(
    parsePublicToken('https://www.icloud.com/sharedalbum/ja-jp/#D1sv3QDqbToken;B3D698B8-5881-4191-9D91-E54747864969'),
    'D1sv3QDqbToken'
  );
});

test('builds the partitioned sharedstreams base URL', () => {
  assert.equal(
    getBaseUrl('B0z5qXGF1ExampleToken'),
    'https://p61-sharedstreams.icloud.com/B0z5qXGF1ExampleToken/sharedstreams/'
  );
});

test('prefers dateCreated over batchDateCreated', () => {
  const dateInfo = parseDateInfo({
    dateCreated: '2024-02-01T12:00:00Z',
    batchDateCreated: '2024-01-01T12:00:00Z'
  });

  assert.equal(dateInfo.capturedAt, '2024-02-01T12:00:00.000Z');
});

test('normalizes photo derivatives and picks grid and full URLs', () => {
  const urls = new Map([
    ['small', 'https://example.com/small.jpg'],
    ['large', 'https://example.com/large.jpg']
  ]);
  const photo = normalizePhoto(
    {
      photoGuid: 'photo-1',
      dateCreated: '2024-03-01T00:00:00Z',
      width: '2048',
      height: '1536',
      derivatives: {
        small: { checksum: 'small', width: '300', height: '225', fileSize: '1000' },
        large: { checksum: 'large', width: '2048', height: '1536', fileSize: '5000' }
      }
    },
    0,
    urls
  );

  assert.equal(photo.gridUrl, 'https://example.com/large.jpg');
  assert.equal(photo.fullUrl, 'https://example.com/large.jpg');
  assert.match(photo.srcset, /small\.jpg 300w/);
});

test('normalizes video poster frames separately from mp4 playback URLs', () => {
  const urls = new Map([
    ['video-large', 'https://example.com/video-720p.mp4'],
    ['poster', 'https://example.com/poster.JPG'],
    ['video-small', 'https://example.com/video-360p.mp4']
  ]);
  const photo = normalizePhoto(
    {
      photoGuid: 'video-1',
      mediaAssetType: 'video',
      dateCreated: '2024-03-01T00:00:00Z',
      derivatives: {
        '720p': { checksum: 'video-large', width: '1280', height: '720', fileSize: '5000' },
        PosterFrame: { checksum: 'poster', width: '1280', height: '720', fileSize: '1000' },
        '360p': { checksum: 'video-small', width: '640', height: '360', fileSize: '2000' }
      }
    },
    0,
    urls
  );

  assert.equal(photo.type, 'video');
  assert.equal(photo.posterUrl, 'https://example.com/poster.JPG');
  assert.equal(photo.gridUrl, 'https://example.com/poster.JPG');
  assert.equal(photo.videoUrl, 'https://example.com/video-720p.mp4');
  assert.equal(photo.fullUrl, 'https://example.com/video-720p.mp4');
  assert.doesNotMatch(photo.srcset, /mp4/);
});

test('sorts photos chronologically and keeps album order for ties', () => {
  const sorted = sortPhotos([
    { id: 'b', capturedAtEpoch: 2000, index: 1 },
    { id: 'c', capturedAtEpoch: 2000, index: 2 },
    { id: 'a', capturedAtEpoch: 1000, index: 0 }
  ]);

  assert.deepEqual(
    sorted.map((photo) => photo.id),
    ['a', 'b', 'c']
  );
});

test('applies a recognized date marker to following album-order photos', () => {
  const photos = [
    { id: 'photo-before', index: 0, capturedAtEpoch: 10, capturedAt: '2026-09-01T01:00:00.000Z' },
    { id: 'marker', index: 1, capturedAtEpoch: 1, capturedAt: '2026-08-01T01:00:00.000Z' },
    { id: 'photo-after', index: 2, capturedAtEpoch: 20, capturedAt: '2026-09-03T01:00:00.000Z' }
  ];
  const timeline = applyDateMarkers(photos, [
    { photoId: 'marker', isDateMarker: true, date: '2026-09-06', confidence: 0.96 }
  ]);

  assert.equal(timeline[0].dateSource, 'metadata');
  assert.equal(timeline[1].isDateMarker, true);
  assert.equal(timeline[2].markerDate, '2026-09-06');
  assert.equal(timeline[2].effectiveCapturedAt, '2026-09-06T00:00:00.020Z');
});

test('can apply a recognized date marker to previous album-order photos', () => {
  const photos = [
    { id: 'photo-before', index: 0, capturedAtEpoch: 20, capturedAt: '2026-09-03T01:00:00.000Z' },
    { id: 'marker', index: 1, capturedAtEpoch: 1, capturedAt: '2026-08-01T01:00:00.000Z' },
    { id: 'photo-after', index: 2, capturedAtEpoch: 10, capturedAt: '2026-09-01T01:00:00.000Z' }
  ];
  const timeline = applyDateMarkers(
    photos,
    [{ photoId: 'marker', isDateMarker: true, date: '2026-09-06', confidence: 0.96 }],
    { mode: 'previous' }
  );

  assert.equal(timeline[0].markerDate, '2026-09-06');
  assert.equal(timeline[1].isDateMarker, true);
  assert.equal(timeline[2].dateSource, 'metadata');
});

test('infers date cards from repeated album-order separator images', () => {
  const cardEpoch = Date.UTC(2026, 7, 28, 11, 0, 51);
  const photos = [
    { id: 'card-7', index: 0, type: 'image', width: 1080, height: 1620, capturedAtEpoch: cardEpoch },
    { id: 'sep6-a', index: 1, type: 'image', width: 2049, height: 1537, capturedAtEpoch: Date.UTC(2026, 8, 6, 8) },
    { id: 'sep6-b', index: 2, type: 'image', width: 2049, height: 1537, capturedAtEpoch: Date.UTC(2026, 8, 6, 9) },
    { id: 'card-6', index: 3, type: 'image', width: 1080, height: 1620, capturedAtEpoch: cardEpoch },
    { id: 'sep5-a', index: 4, type: 'image', width: 2049, height: 1537, capturedAtEpoch: Date.UTC(2026, 8, 5, 8) },
    { id: 'card-5', index: 5, type: 'image', width: 1080, height: 1620, capturedAtEpoch: cardEpoch }
  ];
  const markers = inferAlbumOrderDateMarkers(photos);

  assert.deepEqual(
    markers.map((marker) => [marker.photoId, marker.date]),
    [
      ['card-7', '2026-09-07'],
      ['card-6', '2026-09-06'],
      ['card-5', '2026-09-05']
    ]
  );
});

test('infers square date cards created on the same day at different times', () => {
  const cardEarly = Date.UTC(2026, 5, 22, 9, 15);
  const cardLate = Date.UTC(2026, 5, 22, 11, 43);
  const photos = [
    { id: 'photo-24-a', index: 0, type: 'image', width: 2049, height: 1537, capturedAtEpoch: Date.UTC(2026, 5, 24, 8) },
    { id: 'card-24', index: 1, type: 'image', width: 1170, height: 1170, capturedAtEpoch: cardLate },
    { id: 'photo-23-a', index: 2, type: 'image', width: 2049, height: 1537, capturedAtEpoch: Date.UTC(2026, 5, 23, 8) },
    { id: 'card-23', index: 3, type: 'image', width: 1170, height: 1170, capturedAtEpoch: cardLate },
    { id: 'photo-22-a', index: 4, type: 'image', width: 2049, height: 1537, capturedAtEpoch: Date.UTC(2026, 5, 22, 8) },
    { id: 'card-22', index: 5, type: 'image', width: 1170, height: 1170, capturedAtEpoch: cardEarly }
  ];
  const markers = inferAlbumOrderDateMarkers(photos);

  assert.deepEqual(
    markers.map((marker) => [marker.photoId, marker.date]),
    [
      ['card-24', '2026-06-24'],
      ['card-23', '2026-06-23'],
      ['card-22', '2026-06-22']
    ]
  );
});

test('repairs a leading date-card outlier from a daily run', () => {
  const cardEpoch = Date.UTC(2026, 5, 24, 17, 50, 59);
  const photos = [
    { id: 'unrelated-before', index: 0, type: 'image', width: 2049, height: 1537, capturedAtEpoch: Date.UTC(2026, 6, 15, 8) },
    { id: 'card-30', index: 1, type: 'image', width: 1080, height: 1080, capturedAtEpoch: cardEpoch },
    { id: 'photo-29-a', index: 2, type: 'image', width: 2049, height: 1537, capturedAtEpoch: Date.UTC(2026, 5, 29, 8) },
    { id: 'card-29', index: 3, type: 'image', width: 1080, height: 1080, capturedAtEpoch: cardEpoch },
    { id: 'photo-28-a', index: 4, type: 'image', width: 2049, height: 1537, capturedAtEpoch: Date.UTC(2026, 5, 28, 8) },
    { id: 'card-28', index: 5, type: 'image', width: 1080, height: 1080, capturedAtEpoch: cardEpoch }
  ];
  const markers = inferAlbumOrderDateMarkers(photos);

  assert.deepEqual(
    markers.map((marker) => [marker.photoId, marker.date]),
    [
      ['card-30', '2026-06-30'],
      ['card-29', '2026-06-29'],
      ['card-28', '2026-06-28']
    ]
  );
});

test('infers larger generated date-card batches', () => {
  const photos = [];
  const baseEpoch = Date.UTC(2026, 6, 15, 8);
  const cardEpoch = Date.UTC(2026, 6, 7, 14, 18, 55);

  for (let offset = 0; offset < 52; offset += 1) {
    const epoch = baseEpoch - offset * 24 * 60 * 60 * 1000;
    const date = new Date(epoch).toISOString().slice(0, 10);
    photos.push({ id: `photo-${date}`, index: offset * 2, type: 'image', width: 2049, height: 1537, capturedAtEpoch: epoch });
    photos.push({ id: `card-${date}`, index: offset * 2 + 1, type: 'image', width: 1080, height: 1620, capturedAtEpoch: cardEpoch });
  }

  const markers = inferAlbumOrderDateMarkers(photos);

  assert.equal(markers.length, 52);
  assert.deepEqual(
    markers.slice(0, 3).map((marker) => [marker.photoId, marker.date]),
    [
      ['card-2026-07-15', '2026-07-15'],
      ['card-2026-07-14', '2026-07-14'],
      ['card-2026-07-13', '2026-07-13']
    ]
  );
});

test('applies inferred date cards and marks separator images', () => {
  const cardEpoch = Date.UTC(2026, 7, 28, 11, 0, 51);
  const photos = [
    { id: 'card-7', index: 0, type: 'image', width: 1080, height: 1620, capturedAtEpoch: cardEpoch },
    { id: 'sep6-a', index: 1, type: 'image', width: 2049, height: 1537, capturedAtEpoch: Date.UTC(2026, 8, 6, 8) },
    { id: 'card-6', index: 2, type: 'image', width: 1080, height: 1620, capturedAtEpoch: cardEpoch },
    { id: 'sep5-a', index: 3, type: 'image', width: 2049, height: 1537, capturedAtEpoch: Date.UTC(2026, 8, 5, 8) },
    { id: 'card-5', index: 4, type: 'image', width: 1080, height: 1620, capturedAtEpoch: cardEpoch }
  ];
  const timeline = applyInferredDateCards(photos);

  assert.equal(timeline.markers.length, 3);
  assert.equal(timeline.photos.find((photo) => photo.id === 'card-6').isDateMarker, true);
  assert.equal(timeline.photos.find((photo) => photo.id === 'sep6-a').markerDate, '2026-09-06');
});

