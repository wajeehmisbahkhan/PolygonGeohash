import { PolygonGeoJson, HashMode } from './types';
import {
  bbox,
  envelope,
  area,
  bboxPolygon,
  intersect,
  booleanOverlap,
  polygon,
  BBox,
  Feature,
  Polygon,
  Properties,
  booleanWithin,
  lineSplit,
  lineString
} from '@turf/turf';
import * as ngeohash from 'ngeohash';

let rowProgress = -Infinity;
let turfShape: Feature<Polygon, Properties>;

export function polygongeohash(
  polygonGeoJson: PolygonGeoJson = [],
  precision = 6,
  hashMode: HashMode = 'intersect',
  minIntersect = 0
): Array<string> {
  // CONSTRUCTOR
  turfShape = polygon(polygonGeoJson);

  // [minX, minY, maxX, maxY]
  const originalEnvelopeBbox = bbox(envelope(turfShape));

  // [minX, minY, maxX, maxY]
  const topLeftGeohashBbox = switchBbox(
    ngeohash.decode_bbox(
      ngeohash.encode(
        originalEnvelopeBbox[3],
        originalEnvelopeBbox[0],
        precision
      )
    )
  );

  // [minX, minY, maxX, maxY]
  const bottomRightGeohashBbox = switchBbox(
    ngeohash.decode_bbox(
      ngeohash.encode(
        originalEnvelopeBbox[1],
        originalEnvelopeBbox[2],
        precision
      )
    )
  );

  // The extended geohash envelope covers the area from top left geohash until bottom right geohash
  // I use it instead of the original envelope because I want every row match the real geohash row
  const geohashEnvelopeBbox = [
    topLeftGeohashBbox[0],
    bottomRightGeohashBbox[1],
    bottomRightGeohashBbox[2],
    topLeftGeohashBbox[3]
  ];

  const rowWidth = Math.abs(geohashEnvelopeBbox[2] - geohashEnvelopeBbox[0]);
  const geohashHeight = Math.abs(topLeftGeohashBbox[3] - topLeftGeohashBbox[1]);

  // Current point is the top left corner of the extended geohash envelope
  // Traversing the polygon from top to bottom
  const currentPoint = [geohashEnvelopeBbox[0], geohashEnvelopeBbox[3]];

  // Bottom border of the extended geohash envelope
  const bottomLimit = geohashEnvelopeBbox[1];

  // The minimum shared area between the polygon and the geohash
  const minIntersectArea = minIntersect * area(bboxPolygon(topLeftGeohashBbox));

  const geohashes: Array<string> = []; // Geohashes for all rows

  // Until we have reached the bottom of the polygon
  while (currentPoint[1] > bottomLimit) {
    // Calculate the row polygon
    const rowPolygon = bboxPolygon([
      currentPoint[0],
      currentPoint[1] - geohashHeight,
      currentPoint[0] + rowWidth,
      currentPoint[1]
    ]);

    if (hashMode === 'envelope') {
      geohashes.push(
        ...processRowSegment(
          rowPolygon.geometry!.coordinates,
          minIntersectArea,
          precision,
          hashMode
        )
      );
    } else {
      // Calculate the intersection between the row and the original polygon
      const intersectionGeoJSON = intersect(turfShape, rowPolygon);
      if (intersectionGeoJSON !== null) {
        let coordinates = [intersectionGeoJSON.geometry.coordinates];

        // Check every intersection part for geohashes
        coordinates.forEach(polygon => {
          geohashes.push(
            ...processRowSegment(polygon, minIntersectArea, precision, hashMode)
          );
        });
      }
    }

    // Move one row lower
    currentPoint[1] -= geohashHeight;
  }

  return geohashes;
}

function switchBbox(bbox: ngeohash.GeographicBoundingBox): BBox {
  const [y1, x1, y2, x2] = bbox;
  return [x1, y1, x2, y2];
}

// Returns all the geohashes that are within the current row
function processRowSegment(
  coordinates: Array<Array<Array<number>>>,
  minIntersectArea: number,
  precision: number,
  hashMode: HashMode
) {
  // Convert coordinates into polygon object
  const segmentPolygon = polygon(coordinates);
  const envelopeBbox = bbox(envelope(segmentPolygon));

  // Most left geohash in box OR the next geohash after current rowProgress
  const startingGeohash = ngeohash.encode(
    envelopeBbox[3],
    Math.max(rowProgress, envelopeBbox[0] + 0.00001), // Add some small long value to avoid edge cases
    precision
  );

  const geohashList: Array<string> = [];

  // Checking every geohash in the row from left to right
  let currentGeohash = startingGeohash;

  while (true) {
    const geohashPolygon = bboxPolygon(
      switchBbox(ngeohash.decode_bbox(currentGeohash))
    );

    let addGeohash = false;

    switch (hashMode) {
      case 'intersect':
        // Only add geohash if they intersect/overlap with the original polygon
        addGeohash = booleanOverlap(segmentPolygon, geohashPolygon);

        if (addGeohash && minIntersectArea > 0) {
          const intersected = intersect(turfShape, geohashPolygon)!;
          addGeohash = area(intersected) >= minIntersectArea;
        }
        break;
      case 'envelope':
        addGeohash = true; // add every geohash
        break;
      case 'insideOnly':
        // Only add geohash if it is completely within the original polygon
        addGeohash =
          booleanWithin(geohashPolygon, turfShape) &&
          allRectangleEdgesWithin(geohashPolygon, turfShape);
        // Extra check to avoid turf.js bug
        // REMOVE allRectangleEdgesWithin CHECK IF POSSIBLE -> NEGATIVE PERFORMANCE IMPACT
        break;
      case 'border':
        // Only add geohash if they overlap
        addGeohash =
          booleanOverlap(segmentPolygon, geohashPolygon) &&
          !booleanWithin(geohashPolygon, turfShape);
        break;
    }

    // Check if geohash polygon overlaps/intersects with original polygon
    // I need to check both because of some weird bug with turf

    // If yes -> add it to the list of geohashes
    if (addGeohash) {
      geohashList.push(currentGeohash);
    }

    // Save rowProgress
    // maxX plus some small amount to avoid overlapping edges due to lat/long inaccuracies
    rowProgress = bbox(geohashPolygon)[2] + 0.00001;

    // TODO: Risky change
    const maxX = geohashPolygon.bbox ? geohashPolygon.bbox[2] : Infinity;
    if (maxX >= envelopeBbox[2]) {
      // If right edge of current geohash is out of bounds we are done
      // TODO: Risky change
      // currentGeohash = null;
      break;
    }

    // Get eastern neighbor and set him as next geohash to be checked
    currentGeohash = ngeohash.neighbor(currentGeohash, [0, 1]);
  }

  return geohashList;
}

function allRectangleEdgesWithin(
  polygon1: Feature<Polygon>,
  polygon2: Feature<Polygon>
) {
  const box = bbox(polygon1);
  const edge = lineString([
    [box[0], box[3]], // Top edge
    [box[2], box[3]], // Top edge
    [box[2], box[3]], // Right edge
    [box[2], box[1]], // Right edge
    [box[2], box[1]], // Bottom edge
    [box[0], box[1]], // Bottom edge
    [box[0], box[1]], // Left edge
    [box[0], box[3]] // Left edge
  ]);
  // Make sure the polygon does not split the line into separate segments
  return lineSplit(edge, polygon2).features.length === 0;
}
