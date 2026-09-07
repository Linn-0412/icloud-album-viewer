function normalizeDateOnly(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const epoch = Date.UTC(year, month - 1, day);
  const date = new Date(epoch);

  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }

  return {
    date: raw,
    epoch,
    iso: new Date(epoch).toISOString()
  };
}

function isUsableMarker(marker, confidenceThreshold = 0.72) {
  return (
    marker &&
    marker.isDateMarker === true &&
    Number(marker.confidence || 0) >= confidenceThreshold &&
    normalizeDateOnly(marker.date)
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

function combineDateWithPhotoTime(markerEpoch, photoEpoch) {
  if (!Number.isFinite(photoEpoch)) {
    return markerEpoch;
  }

  const timeOfDay = ((photoEpoch % DAY_MS) + DAY_MS) % DAY_MS;
  return markerEpoch + timeOfDay;
}

function applyDateMarkers(photos, markers, options = {}) {
  if (options.mode === 'previous') {
    return applyPreviousDateMarkers(photos, markers, options);
  }

  return applyNextDateMarkers(photos, markers, options);
}

function applyNextDateMarkers(photos, markers, options = {}) {
  const confidenceThreshold = Number(options.confidenceThreshold || 0.72);
  const markerByPhotoId = new Map(
    markers
      .filter((marker) => isUsableMarker(marker, confidenceThreshold))
      .map((marker) => [marker.photoId, marker])
  );
  const photosByAlbumOrder = [...photos].sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  const assignedById = new Map();
  let currentMarker = null;

  for (const photo of photosByAlbumOrder) {
    const marker = markerByPhotoId.get(photo.id);

    if (marker) {
      const normalized = normalizeDateOnly(marker.date);
      currentMarker = {
        photoId: photo.id,
        date: normalized.date,
        iso: normalized.iso,
        epoch: normalized.epoch,
        confidence: Number(marker.confidence || 0)
      };
      assignedById.set(photo.id, {
        ...photo,
        isDateMarker: true,
        markerDate: currentMarker.date,
        markerConfidence: currentMarker.confidence,
        effectiveCapturedAt: currentMarker.iso,
        effectiveCapturedAtEpoch: currentMarker.epoch,
        dateSource: 'marker'
      });
      continue;
    }

    if (currentMarker) {
      const effectiveEpoch = combineDateWithPhotoTime(currentMarker.epoch, Number(photo.capturedAtEpoch));
      assignedById.set(photo.id, {
        ...photo,
        isDateMarker: false,
        markerDate: currentMarker.date,
        markerSourcePhotoId: currentMarker.photoId,
        effectiveCapturedAt: new Date(effectiveEpoch).toISOString(),
        effectiveCapturedAtEpoch: effectiveEpoch,
        dateSource: 'marker'
      });
      continue;
    }

    assignedById.set(photo.id, {
      ...photo,
      isDateMarker: false,
      effectiveCapturedAt: photo.capturedAt,
      effectiveCapturedAtEpoch: photo.capturedAtEpoch,
      dateSource: 'metadata'
    });
  }

  return photos.map((photo) => assignedById.get(photo.id) || photo);
}

function applyPreviousDateMarkers(photos, markers, options = {}) {
  const confidenceThreshold = Number(options.confidenceThreshold || 0.72);
  const photosByAlbumOrder = [...photos].sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  const markerByPhotoId = new Map(
    markers
      .filter((marker) => isUsableMarker(marker, confidenceThreshold))
      .map((marker) => [marker.photoId, marker])
  );
  const markerPhotos = photosByAlbumOrder.filter((photo) => markerByPhotoId.has(photo.id));
  const assignedById = new Map();
  let previousMarkerIndex = -1;

  for (const markerPhoto of markerPhotos) {
    const marker = markerByPhotoId.get(markerPhoto.id);
    const normalized = normalizeDateOnly(marker.date);

    for (const photo of photosByAlbumOrder) {
      if (photo.index <= previousMarkerIndex || photo.index >= markerPhoto.index || markerByPhotoId.has(photo.id)) {
        continue;
      }

      const effectiveEpoch = combineDateWithPhotoTime(normalized.epoch, Number(photo.capturedAtEpoch));
      assignedById.set(photo.id, {
        ...photo,
        isDateMarker: false,
        markerDate: normalized.date,
        markerSourcePhotoId: markerPhoto.id,
        effectiveCapturedAt: new Date(effectiveEpoch).toISOString(),
        effectiveCapturedAtEpoch: effectiveEpoch,
        dateSource: 'marker'
      });
    }

    assignedById.set(markerPhoto.id, {
      ...markerPhoto,
      isDateMarker: true,
      markerDate: normalized.date,
      markerConfidence: Number(marker.confidence || 0),
      effectiveCapturedAt: normalized.iso,
      effectiveCapturedAtEpoch: normalized.epoch,
      dateSource: 'marker'
    });
    previousMarkerIndex = markerPhoto.index;
  }

  for (const photo of photos) {
    if (!assignedById.has(photo.id)) {
      assignedById.set(photo.id, {
        ...photo,
        isDateMarker: Boolean(markerByPhotoId.has(photo.id)),
        effectiveCapturedAt: photo.effectiveCapturedAt || photo.capturedAt,
        effectiveCapturedAtEpoch: photo.effectiveCapturedAtEpoch ?? photo.capturedAtEpoch,
        dateSource: photo.dateSource || 'metadata'
      });
    }
  }

  return photos.map((photo) => assignedById.get(photo.id) || photo);
}

function toDateKey(epoch) {
  if (!Number.isFinite(epoch)) {
    return null;
  }

  return new Date(epoch).toISOString().slice(0, 10);
}

function addDays(dateKey, days) {
  const normalized = normalizeDateOnly(dateKey);
  if (!normalized) {
    return null;
  }

  return new Date(normalized.epoch + days * DAY_MS).toISOString().slice(0, 10);
}

function dominantDateKey(segmentPhotos, excludedIds) {
  const counts = new Map();

  for (const photo of segmentPhotos) {
    if (excludedIds.has(photo.id) || photo.type === 'video' && !photo.capturedAtEpoch) {
      continue;
    }

    const dateKey = toDateKey(Number(photo.capturedAtEpoch));
    if (!dateKey) {
      continue;
    }

    counts.set(dateKey, (counts.get(dateKey) || 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function groupDateCardCandidates(photos, options = {}) {
  const minCards = Number(options.minCards || 3);
  const maxCards = Number(options.maxCards || 40);
  const minLongSide = Number(options.minLongSide || options.minHeight || 900);
  const minShortSide = Number(options.minShortSide || 500);
  const minAspect = Number(options.minAspect || 0.55);
  const maxAspect = Number(options.maxAspect || 1.05);
  const groups = new Map();

  for (const photo of photos) {
    const width = Number(photo.width || 0);
    const height = Number(photo.height || 0);
    const aspect = height ? width / height : 0;
    const longSide = Math.max(width, height);
    const shortSide = Math.min(width, height);
    const captureDateKey = toDateKey(Number(photo.capturedAtEpoch));

    if (
      photo.type !== 'image' ||
      !Number.isFinite(Number(photo.capturedAtEpoch)) ||
      !captureDateKey ||
      shortSide < minShortSide ||
      longSide < minLongSide ||
      aspect < minAspect ||
      aspect > maxAspect
    ) {
      continue;
    }

    const key = `${captureDateKey}|${width}|${height}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(photo);
  }

  return [...groups.values()].filter((group) => group.length >= minCards && group.length <= maxCards);
}

function inferDatesForCandidateGroup(photosByAlbumOrder, group) {
  const excludedIds = new Set(group.map((photo) => photo.id));
  const sortedGroup = [...group].sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  const markerDates = sortedGroup.map((photo, index) => {
    const previousIndex = index === 0 ? -1 : Number(sortedGroup[index - 1].index || 0);
    const segment = photosByAlbumOrder.filter(
      (candidate) => Number(candidate.index || 0) > previousIndex && Number(candidate.index || 0) < Number(photo.index || 0)
    );

    return {
      photo,
      date: dominantDateKey(segment, excludedIds),
      inferred: false
    };
  });

  const knownDates = markerDates.filter((marker) => marker.date);
  if (knownDates.length >= 1 && !markerDates[0].date) {
    const firstKnownIndex = markerDates.findIndex((marker) => marker.date);
    if (firstKnownIndex >= 0) {
      markerDates[0].date = addDays(markerDates[firstKnownIndex].date, firstKnownIndex);
      markerDates[0].inferred = true;
    }
  }

  return markerDates.filter((marker) => marker.date);
}

function scoreMarkerDates(markerDates) {
  const timestamps = markerDates.map((marker) => normalizeDateOnly(marker.date)?.epoch).filter(Number.isFinite);
  const uniqueCount = new Set(markerDates.map((marker) => marker.date)).size;

  if (markerDates.length < 2 || uniqueCount < 2) {
    return 0;
  }

  let descendingSteps = 0;
  let comparableSteps = 0;
  for (let index = 1; index < timestamps.length; index += 1) {
    comparableSteps += 1;
    if (timestamps[index - 1] > timestamps[index]) {
      descendingSteps += 1;
    }
  }

  const directionRatio = comparableSteps ? descendingSteps / comparableSteps : 0;
  if (directionRatio < 0.65) {
    return 0;
  }

  return uniqueCount * 5 + markerDates.length + directionRatio * 10;
}

function inferAlbumOrderDateMarkers(photos, options = {}) {
  const photosByAlbumOrder = [...photos].sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  const groups = groupDateCardCandidates(photosByAlbumOrder, options);
  const scoredGroups = groups
    .map((group) => {
      const markerDates = inferDatesForCandidateGroup(photosByAlbumOrder, group);
      return {
        markerDates,
        score: scoreMarkerDates(markerDates)
      };
    })
    .filter((group) => group.score > 0)
    .sort((a, b) => b.score - a.score);

  const markersByPhotoId = new Map();
  for (const group of scoredGroups) {
    for (const marker of group.markerDates) {
      if (markersByPhotoId.has(marker.photo.id)) {
        continue;
      }

      markersByPhotoId.set(marker.photo.id, {
        photoId: marker.photo.id,
        isDateMarker: true,
        date: marker.date,
        confidence: marker.inferred ? 0.78 : 0.9,
        text: marker.inferred ? 'inferred from adjacent date cards' : 'inferred from surrounding album photos'
      });
    }
  }

  return [...markersByPhotoId.values()];
}

function applyInferredDateCards(photos, options = {}) {
  const markers = inferAlbumOrderDateMarkers(photos, options);
  return {
    markers,
    photos: markers.length > 0 ? applyDateMarkers(photos, markers, { ...options, mode: 'previous' }) : photos
  };
}

module.exports = {
  normalizeDateOnly,
  combineDateWithPhotoTime,
  applyDateMarkers,
  applyPreviousDateMarkers,
  inferAlbumOrderDateMarkers,
  applyInferredDateCards,
  isUsableMarker
};
