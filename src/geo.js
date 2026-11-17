// Omrekening tussen GPS (lon/lat, WGS84) en lokale scene-meters.
// x = oost, z = zuid (three.js: -z is noord). Nauwkeurig genoeg op ~1,5 km.
export function createGeo(meta) {
  const { origin, metersPerDeg: m, extent } = meta;
  const R = 6371008.8, rad = Math.PI / 180;
  return {
    toLocal: (lon, lat) => [(lon - origin.lon) * m.lon, -(lat - origin.lat) * m.lat],
    toLonLat: (x, z) => [origin.lon + x / m.lon, origin.lat - z / m.lat],
    inside: (x, z) => x >= extent.minX && x <= extent.maxX && z >= extent.minZ && z <= extent.maxZ,
    // haversine-afstand in meter tussen [lon, lat]-punten
    distance([lo1, la1], [lo2, la2]) {
      const dla = (la2 - la1) * rad, dlo = (lo2 - lo1) * rad;
      const a = Math.sin(dla / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dlo / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(a));
    },
  };
}
