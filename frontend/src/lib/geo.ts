// Geolocation helpers for store auto-selection from photo EXIF GPS.

export interface GeoPoint { lat: number; lng: number; }

// Great-circle distance in meters (haversine).
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const AUTO_SELECT_RADIUS_M = 200;

// Nearest store (with saved coords) within the auto-select radius, or null.
export function nearestStore<T extends { latitude?: string | number | null; longitude?: string | number | null }>(
  gps: GeoPoint,
  stores: T[]
): { store: T; distance: number } | null {
  let best: { store: T; distance: number } | null = null;
  for (const store of stores) {
    if (store.latitude == null || store.longitude == null) continue;
    const d = distanceMeters(gps, { lat: Number(store.latitude), lng: Number(store.longitude) });
    if (!best || d < best.distance) best = { store, distance: d };
  }
  return best && best.distance <= AUTO_SELECT_RADIUS_M ? best : null;
}
