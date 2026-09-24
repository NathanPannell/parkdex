/**
 * Reviewed shortlist of major British Columbia islands outside the existing
 * Vancouver Island focused catalogue.
 *
 * Evidence checks:
 * - Each BC Geographical Names page is an official "Island" feature record.
 *   The page number is the BCGNIS GEOGRAPHICAL_NAMES_ID.
 * - Each OpenStreetMap relation was read from the OSM API and verified to have
 *   the matching name, place=island, and type=multipolygon tags. The relation
 *   supplies a usable map outline; it is volunteered geometry, not a legal
 *   cadastral or protected-area boundary.
 *
 * BCGN pages: https://apps.gov.bc.ca/pub/bcgnws/names/{bcgnFeatureId}.html
 * OSM relations: https://www.openstreetmap.org/relation/{osmRelationId}
 */
export const BC_MAJOR_ISLANDS = Object.freeze([
  Object.freeze({
    name: 'Graham Island',
    displayGroup: 'Haida Gwaii',
    suitability: 'Primary Haida Gwaii island; extensive provincial park coverage.',
    bcgnFeatureId: 28939,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/28939.html',
    osmRelationId: 2145001,
    osmUrl: 'https://www.openstreetmap.org/relation/2145001',
  }),
  Object.freeze({
    name: 'Moresby Island',
    displayGroup: 'Haida Gwaii',
    suitability: 'Second main Haida Gwaii island; includes Gwaii Haanas access and protected lands.',
    bcgnFeatureId: 29951,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/29951.html',
    osmRelationId: 2145060,
    osmUrl: 'https://www.openstreetmap.org/relation/2145060',
  }),
  Object.freeze({
    name: 'Bowen Island',
    displayGroup: 'Howe Sound',
    suitability: 'Inhabited ferry destination with municipal and provincial recreation sites.',
    bcgnFeatureId: 456,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/456.html',
    osmRelationId: 2143957,
    osmUrl: 'https://www.openstreetmap.org/relation/2143957',
  }),
  Object.freeze({
    name: 'Texada Island',
    displayGroup: 'Northern Strait of Georgia',
    suitability: 'Inhabited ferry destination with several provincial parks.',
    bcgnFeatureId: 15098,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/15098.html',
    osmRelationId: 2143897,
    osmUrl: 'https://www.openstreetmap.org/relation/2143897',
  }),
  Object.freeze({
    name: 'Princess Royal Island',
    displayGroup: 'Central Coast',
    suitability: 'Large, geographically prominent wilderness island.',
    bcgnFeatureId: 30978,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/30978.html',
    osmRelationId: 2144713,
    osmUrl: 'https://www.openstreetmap.org/relation/2144713',
  }),
  Object.freeze({
    name: 'Pitt Island',
    displayGroup: 'North Coast',
    suitability: 'Large island between Banks Island and Grenville Channel.',
    bcgnFeatureId: 30670,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/30670.html',
    osmRelationId: 2144805,
    osmUrl: 'https://www.openstreetmap.org/relation/2144805',
  }),
  Object.freeze({
    name: 'Banks Island',
    displayGroup: 'North Coast',
    suitability: 'Large outer-coast island between Hecate Strait and Principe Channel.',
    bcgnFeatureId: 28148,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/28148.html',
    osmRelationId: 2144803,
    osmUrl: 'https://www.openstreetmap.org/relation/2144803',
  }),
  Object.freeze({
    name: 'Porcher Island',
    displayGroup: 'North Coast',
    suitability: 'Inhabited island near the mouth of the Skeena and Prince Rupert.',
    bcgnFeatureId: 30943,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/30943.html',
    osmRelationId: 2144867,
    osmUrl: 'https://www.openstreetmap.org/relation/2144867',
  }),
  Object.freeze({
    name: 'Kaien Island',
    displayGroup: 'North Coast',
    suitability: 'Urban island containing Prince Rupert and its local park destinations.',
    bcgnFeatureId: 35382,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/35382.html',
    osmRelationId: 8399414,
    osmUrl: 'https://www.openstreetmap.org/relation/8399414',
  }),
  Object.freeze({
    name: 'Calvert Island',
    displayGroup: 'Central Coast',
    suitability: 'Prominent coastal wilderness and access point for the Hakai region.',
    bcgnFeatureId: 26741,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/26741.html',
    osmRelationId: 2144098,
    osmUrl: 'https://www.openstreetmap.org/relation/2144098',
  }),
  Object.freeze({
    name: 'Campbell Island',
    displayGroup: 'Central Coast',
    suitability: 'Inhabited island containing Bella Bella.',
    bcgnFeatureId: 29032,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/29032.html',
    osmRelationId: 2144099,
    osmUrl: 'https://www.openstreetmap.org/relation/2144099',
  }),
  Object.freeze({
    name: 'Denny Island',
    displayGroup: 'Central Coast',
    suitability: 'Inhabited island with Shearwater and the historic Bella Bella site.',
    bcgnFeatureId: 14488,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/14488.html',
    osmRelationId: 2144100,
    osmUrl: 'https://www.openstreetmap.org/relation/2144100',
  }),
  Object.freeze({
    name: 'Swindle Island',
    displayGroup: 'Central Coast',
    suitability: 'Inhabited central-coast island containing the Klemtu community.',
    bcgnFeatureId: 30868,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/30868.html',
    osmRelationId: 2144150,
    osmUrl: 'https://www.openstreetmap.org/relation/2144150',
  }),
]);
