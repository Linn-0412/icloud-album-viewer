const form = document.querySelector('#albumForm');
const albumUrlInput = document.querySelector('#albumUrl');
const loadButton = document.querySelector('#loadButton');
const refreshButton = document.querySelector('#refreshButton');
const gallery = document.querySelector('#gallery');
const sentinel = document.querySelector('#sentinel');
const statusText = document.querySelector('#statusText');
const countText = document.querySelector('#countText');
const albumTitle = document.querySelector('#albumTitle');
const groupByDateInput = document.querySelector('#groupByDate');
const hideMarkersInput = document.querySelector('#hideMarkers');
const detectMarkersButton = document.querySelector('#detectMarkers');
const adminLink = document.querySelector('#adminLink');
const logoutButton = document.querySelector('#logoutButton');
const sortButtons = [...document.querySelectorAll('[data-sort]')];
const lightbox = document.querySelector('#lightbox');
const lightboxImage = document.querySelector('#lightboxImage');
const lightboxVideo = document.querySelector('#lightboxVideo');
const lightboxDate = document.querySelector('#lightboxDate');
const lightboxCaption = document.querySelector('#lightboxCaption');
const openOriginal = document.querySelector('#openOriginal');
const prevButton = document.querySelector('#prevButton');
const nextButton = document.querySelector('#nextButton');
const closeButton = document.querySelector('#closeButton');

const BATCH_SIZE = 80;
const dateFormatter = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
});
const dayFormatter = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'short'
});

let photos = [];
let originalPhotos = [];
let visiblePhotos = [];
let sortDirection = 'asc';
let renderedCount = 0;
let lastDateHeading = '';
let activeIndex = 0;
let observer = null;
let assetRequests = new Set();

function formatDate(value) {
  if (!value) {
    return '日付なし';
  }

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : '日付なし';
}

function formatDay(value) {
  if (!value) {
    return '日付なし';
  }

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dayFormatter.format(date) : '日付なし';
}

function getEffectiveDate(photo) {
  return photo.effectiveCapturedAt || photo.capturedAt;
}

function getEffectiveEpoch(photo) {
  return photo.effectiveCapturedAtEpoch ?? photo.capturedAtEpoch ?? Number.MAX_SAFE_INTEGER;
}

function getDateSourceLabel(photo) {
  if (photo.dateSource === 'marker') {
    return photo.isDateMarker ? '日付カード' : '日付カード基準';
  }

  return 'メタデータ';
}

function isVideo(photo) {
  return photo.type === 'video';
}

function hasMediaUrl(photo) {
  return Boolean(photo?.gridUrl || photo?.fullUrl || photo?.videoUrl);
}

function setStatus(message, count = visiblePhotos.length) {
  statusText.textContent = message;
  countText.textContent = `${count.toLocaleString('ja-JP')}枚`;
}

function redirectToLogin() {
  window.location.assign('/login');
}

async function readJsonResponse(response, fallbackMessage) {
  const payload = await response.json().catch(() => ({}));

  if (response.status === 401) {
    redirectToLogin();
    throw new Error('ログインが必要です。');
  }

  if (!response.ok) {
    throw new Error(payload.error || fallbackMessage);
  }

  return payload;
}

function sortCurrentPhotos() {
  const multiplier = sortDirection === 'desc' ? -1 : 1;
  const sourcePhotos = hideMarkersInput.checked ? photos.filter((photo) => !photo.isDateMarker) : photos;

  visiblePhotos = [...sourcePhotos].sort((a, b) => {
    const aTime = getEffectiveEpoch(a);
    const bTime = getEffectiveEpoch(b);

    if (aTime !== bTime) {
      return (aTime - bTime) * multiplier;
    }

    return (a.index - b.index) * multiplier;
  });
}

function createDateHeading(label) {
  const heading = document.createElement('h2');
  heading.className = 'date-heading';
  heading.textContent = label;
  return heading;
}

function appendMedia(button, photo) {
  if (!hasMediaUrl(photo)) {
    const placeholder = document.createElement('div');
    placeholder.className = 'media-placeholder';
    button.append(placeholder);
    return;
  }

  if (isVideo(photo) && !photo.posterUrl) {
    const video = document.createElement('video');
    video.src = photo.videoUrl || photo.fullUrl;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    button.append(video);
    return;
  }

  const image = document.createElement('img');
  image.src = photo.posterUrl || photo.gridUrl || photo.fullUrl;
  image.alt = photo.caption || formatDate(getEffectiveDate(photo));
  image.loading = 'lazy';
  image.decoding = 'async';
  if (photo.srcset) {
    image.srcset = photo.srcset;
    image.sizes = '(max-width: 620px) 33vw, (max-width: 980px) 25vw, 180px';
  }
  button.append(image);
}

function createPhotoCard(photo, index) {
  const item = document.createElement('article');
  item.className = 'photo-card';
  item.classList.toggle('is-marker', photo.isDateMarker === true);

  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.index = String(index);
  button.dataset.photoId = photo.id;
  button.setAttribute('aria-label', formatDate(getEffectiveDate(photo)));
  appendMedia(button, photo);

  if (isVideo(photo)) {
    const badge = document.createElement('span');
    badge.className = 'play-badge';
    badge.textContent = '▶';
    item.append(badge);
  }

  const time = document.createElement('time');
  const effectiveDate = getEffectiveDate(photo);
  if (effectiveDate) {
    time.dateTime = effectiveDate;
  }
  time.textContent = photo.dateSource === 'marker' ? formatDay(effectiveDate) : formatDate(effectiveDate);

  item.append(button, time);
  return item;
}

function appendNextBatch() {
  if (renderedCount >= visiblePhotos.length) {
    return;
  }

  const fragment = document.createDocumentFragment();
  const nextPhotos = visiblePhotos.slice(renderedCount, renderedCount + BATCH_SIZE);
  const shouldGroup = groupByDateInput.checked;

  nextPhotos.forEach((photo, offset) => {
    const absoluteIndex = renderedCount + offset;
    if (shouldGroup) {
      const label = formatDay(getEffectiveDate(photo));
      if (label !== lastDateHeading) {
        fragment.append(createDateHeading(label));
        lastDateHeading = label;
      }
    }

    fragment.append(createPhotoCard(photo, absoluteIndex));
  });

  renderedCount += nextPhotos.length;
  gallery.append(fragment);
  loadMissingAssets(nextPhotos);
}

function mergeUpdatedPhotos(updatedPhotos) {
  const updatesById = new Map(updatedPhotos.map((photo) => [photo.id, photo]));
  const mergePhoto = (photo) => (updatesById.has(photo.id) ? { ...photo, ...updatesById.get(photo.id) } : photo);

  photos = photos.map(mergePhoto);
  originalPhotos = originalPhotos.map(mergePhoto);
  visiblePhotos = visiblePhotos.map(mergePhoto);
}

function updateRenderedCard(photo) {
  for (const button of gallery.querySelectorAll('button[data-photo-id]')) {
    if (button.dataset.photoId !== photo.id) {
      continue;
    }

    button.replaceChildren();
    button.setAttribute('aria-label', formatDate(getEffectiveDate(photo)));
    appendMedia(button, photo);

    const item = button.closest('.photo-card');
    const existingBadge = item.querySelector('.play-badge');
    if (isVideo(photo) && !existingBadge) {
      const badge = document.createElement('span');
      badge.className = 'play-badge';
      badge.textContent = '▶';
      item.append(badge);
    } else if (!isVideo(photo) && existingBadge) {
      existingBadge.remove();
    }

    const time = item.querySelector('time');
    const effectiveDate = getEffectiveDate(photo);
    if (effectiveDate) {
      time.dateTime = effectiveDate;
    }
    time.textContent = photo.dateSource === 'marker' ? formatDay(effectiveDate) : formatDate(effectiveDate);
  }
}

async function loadMissingAssets(targetPhotos, options = {}) {
  const missingIds = targetPhotos
    .filter((photo) => photo?.id && !hasMediaUrl(photo) && !assetRequests.has(photo.id))
    .map((photo) => photo.id);

  if (missingIds.length === 0) {
    return [];
  }

  missingIds.forEach((id) => assetRequests.add(id));

  try {
    const response = await fetch('/api/assets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: albumUrlInput.value, ids: missingIds })
    });
    const payload = await readJsonResponse(response, '画像URLの取得に失敗しました。');
    const updatedPhotos = Array.isArray(payload.photos) ? payload.photos : [];

    mergeUpdatedPhotos(updatedPhotos);
    updatedPhotos.forEach(updateRenderedCard);
    return updatedPhotos;
  } catch (error) {
    missingIds.forEach((id) => assetRequests.delete(id));
    if (!options.silent) {
      setStatus(error.message, visiblePhotos.length);
    }
    if (options.throwOnError) {
      throw error;
    }
    return [];
  }
}

function renderGallery() {
  sortCurrentPhotos();
  gallery.replaceChildren();
  renderedCount = 0;
  lastDateHeading = '';

  if (visiblePhotos.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '写真がありません';
    gallery.append(empty);
    return;
  }

  appendNextBatch();
}

function setupInfiniteScroll() {
  if (observer) {
    observer.disconnect();
  }

  observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      appendNextBatch();
    }
  });
  observer.observe(sentinel);
}

function updateLoadedState(payload) {
  photos = Array.isArray(payload.photos) ? payload.photos : [];
  originalPhotos = photos.map((photo) => ({ ...photo }));
  assetRequests = new Set();

  const markerCount = photos.filter((photo) => photo.isDateMarker).length;
  hideMarkersInput.disabled = markerCount === 0;
  detectMarkersButton.disabled = photos.length === 0 || detectMarkersButton.dataset.enabled !== 'true';
  refreshButton.disabled = false;
  albumTitle.textContent = payload.metadata?.streamName || '共有アルバム';

  renderGallery();

  const baseStatus = payload.cached ? 'キャッシュから表示' : '読み込み完了';
  const markerStatus = markerCount > 0 ? ` / 日付カード${markerCount.toLocaleString('ja-JP')}件を非表示` : '';
  setStatus(`${baseStatus}${markerStatus}`, visiblePhotos.length);
}

async function loadAlbum(url, options = {}) {
  loadButton.disabled = true;
  refreshButton.disabled = true;
  setStatus('読み込み中', 0);

  const response = await fetch('/api/album', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ url, refresh: options.refresh === true })
  });
  const payload = await readJsonResponse(response, '読み込みに失敗しました。');

  updateLoadedState(payload);
}

async function detectDateMarkers() {
  detectMarkersButton.disabled = true;
  detectMarkersButton.textContent = '解析中';
  setStatus('日付カード解析中', photos.length);

  try {
    const inferredMarkerPhotos = originalPhotos.filter((photo) => photo.isDateMarker);
    const sourcePhotos = inferredMarkerPhotos.length > 0 ? inferredMarkerPhotos : originalPhotos.filter(hasMediaUrl);
    await loadMissingAssets(sourcePhotos, { silent: true, throwOnError: true });

    const updatedInferredMarkerPhotos = originalPhotos.filter((photo) => photo.isDateMarker);
    const candidatePhotos =
      updatedInferredMarkerPhotos.length > 0 ? updatedInferredMarkerPhotos : originalPhotos.filter(hasMediaUrl);
    if (candidatePhotos.length === 0) {
      throw new Error('解析できる画像がまだ読み込まれていません。');
    }

    const markerCandidates = originalPhotos.map((photo) => ({
      id: photo.id,
      index: photo.index,
      isDateMarker: photo.isDateMarker,
      capturedAt: photo.capturedAt,
      capturedAtEpoch: photo.capturedAtEpoch,
      gridUrl: photo.gridUrl,
      fullUrl: photo.fullUrl,
      posterUrl: photo.posterUrl
    })).filter((photo) => candidatePhotos.some((candidate) => candidate.id === photo.id));
    const response = await fetch('/api/date-markers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ photos: markerCandidates })
    });
    const payload = await readJsonResponse(response, '日付カード解析に失敗しました。');

    const markerCount = payload.markers.filter((marker) => marker.isDateMarker && marker.date).length;
    const timelineById = new Map(payload.photos.map((photo) => [photo.id, photo]));
    photos = originalPhotos
      .map((photo) => ({
        ...photo,
        ...(timelineById.get(photo.id) || {})
      }));
    originalPhotos = photos.map((photo) => ({ ...photo }));
    hideMarkersInput.disabled = markerCount === 0;
    renderGallery();
    setStatus(`${markerCount.toLocaleString('ja-JP')}件の日付カードを反映`, visiblePhotos.length);
  } catch (error) {
    setStatus(error.message, photos.length);
  } finally {
    detectMarkersButton.textContent = '日付カード解析';
    detectMarkersButton.disabled = photos.length === 0 || detectMarkersButton.dataset.enabled !== 'true';
  }
}

function setSortDirection(direction) {
  sortDirection = direction;
  sortButtons.forEach((button) => {
    const isActive = button.dataset.sort === direction;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
  renderGallery();
}

async function openLightbox(index) {
  let photo = visiblePhotos[index];
  if (!photo) {
    return;
  }

  if (!hasMediaUrl(photo)) {
    const updatedPhotos = await loadMissingAssets([photo], { throwOnError: true });
    photo = updatedPhotos.find((updatedPhoto) => updatedPhoto.id === photo.id) || visiblePhotos[index];
    if (!hasMediaUrl(photo)) {
      setStatus('画像URLを取得できませんでした。', visiblePhotos.length);
      return;
    }
  }

  activeIndex = index;
  if (isVideo(photo)) {
    lightboxImage.hidden = true;
    lightboxImage.removeAttribute('src');
    lightboxVideo.hidden = false;
    lightboxVideo.src = photo.videoUrl || photo.fullUrl;
    if (photo.posterUrl || photo.gridUrl) {
      lightboxVideo.poster = photo.posterUrl || photo.gridUrl;
    } else {
      lightboxVideo.removeAttribute('poster');
    }
  } else {
    lightboxVideo.pause();
    lightboxVideo.hidden = true;
    lightboxVideo.removeAttribute('src');
    lightboxVideo.removeAttribute('poster');
    lightboxImage.hidden = false;
    lightboxImage.src = photo.fullUrl || photo.gridUrl;
    lightboxImage.alt = photo.caption || formatDate(getEffectiveDate(photo));
  }

  lightboxDate.textContent = `${formatDate(getEffectiveDate(photo))} / ${getDateSourceLabel(photo)}`;
  lightboxCaption.textContent = photo.caption || photo.contributor || '';
  openOriginal.href = photo.videoUrl || photo.fullUrl || photo.gridUrl;
  lightbox.hidden = false;
  closeButton.focus();
}

function closeLightbox() {
  lightbox.hidden = true;
  lightboxImage.removeAttribute('src');
  lightboxVideo.pause();
  lightboxVideo.removeAttribute('src');
  lightboxVideo.removeAttribute('poster');
}

function moveLightbox(step) {
  if (visiblePhotos.length === 0) {
    return;
  }

  const nextIndex = (activeIndex + step + visiblePhotos.length) % visiblePhotos.length;
  openLightbox(nextIndex).catch((error) => {
    setStatus(error.message, visiblePhotos.length);
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    await loadAlbum(albumUrlInput.value);
  } catch (error) {
    photos = [];
    originalPhotos = [];
    visiblePhotos = [];
    refreshButton.disabled = true;
    renderGallery();
    setStatus(error.message, 0);
  } finally {
    loadButton.disabled = false;
  }
});

refreshButton.addEventListener('click', async () => {
  try {
    await loadAlbum(albumUrlInput.value, { refresh: true });
  } catch (error) {
    setStatus(error.message, photos.length);
  } finally {
    loadButton.disabled = false;
    refreshButton.disabled = photos.length === 0;
  }
});

sortButtons.forEach((button) => {
  button.addEventListener('click', () => setSortDirection(button.dataset.sort));
});

groupByDateInput.addEventListener('change', renderGallery);
hideMarkersInput.addEventListener('change', () => {
  renderGallery();
  setStatus(hideMarkersInput.checked ? '日付カードを非表示' : '日付カードを表示', visiblePhotos.length);
});
detectMarkersButton.addEventListener('click', detectDateMarkers);
logoutButton.addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' }).catch(() => {});
  redirectToLogin();
});

gallery.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-index]');
  if (!button) {
    return;
  }

  try {
    await openLightbox(Number(button.dataset.index));
  } catch (error) {
    setStatus(error.message, visiblePhotos.length);
  }
});

closeButton.addEventListener('click', closeLightbox);
prevButton.addEventListener('click', () => moveLightbox(-1));
nextButton.addEventListener('click', () => moveLightbox(1));

lightbox.addEventListener('click', (event) => {
  if (event.target === lightbox) {
    closeLightbox();
  }
});

document.addEventListener('keydown', (event) => {
  if (lightbox.hidden) {
    return;
  }

  if (event.key === 'Escape') {
    closeLightbox();
  } else if (event.key === 'ArrowLeft') {
    moveLightbox(-1);
  } else if (event.key === 'ArrowRight') {
    moveLightbox(1);
  }
});

setupInfiniteScroll();
renderGallery();

fetch('/api/config')
  .then((response) => readJsonResponse(response, '設定の取得に失敗しました。'))
  .then((config) => {
    if (config.hasDefaultAlbum) {
      form.classList.add('is-default-album');
      albumUrlInput.required = false;
      loadButton.textContent = '再読み込み';
      loadAlbum('')
        .catch((error) => {
          setStatus(error.message, 0);
        })
        .finally(() => {
          loadButton.disabled = false;
          refreshButton.disabled = photos.length === 0;
        });
    }

    if (config.visionEnabled) {
      detectMarkersButton.dataset.enabled = 'true';
      detectMarkersButton.disabled = photos.length === 0;
    }

    if (config.user?.isAdmin) {
      adminLink.hidden = false;
    }
  })
  .catch(() => {
    detectMarkersButton.disabled = true;
  });
