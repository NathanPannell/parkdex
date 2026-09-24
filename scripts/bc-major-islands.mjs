/**
 * Reviewed shortlist of major British Columbia islands added beyond the
 * original Vancouver Island focused catalogue.
 *
 * Evidence checks:
 * - Each BC Geographical Names page is an official "Island" feature record.
 *   `bcgnNameId` is the name-page/GEOGRAPHICAL_NAMES_ID from `p.uri`;
 *   `bcgnFeatureId` is the distinct source identity from `p.feature.id`.
 * - Each OpenStreetMap relation was read from the OSM API and verified to have
 *   the matching name, place=island, and type=multipolygon tags. The relation
 *   supplies a usable map outline; it is volunteered geometry, not a legal
 *   cadastral or protected-area boundary.
 *
 * BCGN pages: https://apps.gov.bc.ca/pub/bcgnws/names/{bcgnNameId}.html
 * OSM relations: https://www.openstreetmap.org/relation/{osmRelationId}
 */
export const BC_MAJOR_ISLANDS = Object.freeze([
  Object.freeze({
    name: 'Graham Island',
    displayGroup: 'Haida Gwaii',
    suitability: 'Primary Haida Gwaii island; extensive provincial park coverage.',
    bcgnNameId: 28939,
    bcgnFeatureId: 33487,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/28939.html',
    osmRelationId: 2145001,
    osmUrl: 'https://www.openstreetmap.org/relation/2145001',
  }),
  Object.freeze({
    name: 'Moresby Island',
    displayGroup: 'Haida Gwaii',
    suitability: 'Second main Haida Gwaii island; includes Gwaii Haanas access and protected lands.',
    bcgnNameId: 29951,
    bcgnFeatureId: 34364,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/29951.html',
    osmRelationId: 2145060,
    osmUrl: 'https://www.openstreetmap.org/relation/2145060',
  }),
  Object.freeze({
    name: 'Bowen Island',
    displayGroup: 'Howe Sound',
    suitability: 'Inhabited ferry destination with municipal and provincial recreation sites.',
    bcgnNameId: 456,
    bcgnFeatureId: 9083,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/456.html',
    osmRelationId: 2143957,
    osmUrl: 'https://www.openstreetmap.org/relation/2143957',
  }),
  Object.freeze({
    name: 'Texada Island',
    displayGroup: 'Northern Strait of Georgia',
    suitability: 'Inhabited ferry destination with several provincial parks.',
    bcgnNameId: 15098,
    bcgnFeatureId: 21808,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/15098.html',
    osmRelationId: 2143897,
    osmUrl: 'https://www.openstreetmap.org/relation/2143897',
  }),
  Object.freeze({
    name: 'Princess Royal Island',
    displayGroup: 'Central Coast',
    suitability: 'Large, geographically prominent wilderness island.',
    bcgnNameId: 30978,
    bcgnFeatureId: 3431,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/30978.html',
    osmRelationId: 2144713,
    osmUrl: 'https://www.openstreetmap.org/relation/2144713',
  }),
  Object.freeze({
    name: 'Pitt Island',
    displayGroup: 'North Coast',
    suitability: 'Large island between Banks Island and Grenville Channel.',
    bcgnNameId: 30670,
    bcgnFeatureId: 3407,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/30670.html',
    osmRelationId: 2144805,
    osmUrl: 'https://www.openstreetmap.org/relation/2144805',
  }),
  Object.freeze({
    name: 'Banks Island',
    displayGroup: 'North Coast',
    suitability: 'Large outer-coast island between Hecate Strait and Principe Channel.',
    bcgnNameId: 28148,
    bcgnFeatureId: 3256,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/28148.html',
    osmRelationId: 2144803,
    osmUrl: 'https://www.openstreetmap.org/relation/2144803',
  }),
  Object.freeze({
    name: 'Porcher Island',
    displayGroup: 'North Coast',
    suitability: 'Inhabited island near the mouth of the Skeena and Prince Rupert.',
    bcgnNameId: 30943,
    bcgnFeatureId: 35200,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/30943.html',
    osmRelationId: 2144867,
    osmUrl: 'https://www.openstreetmap.org/relation/2144867',
  }),
  Object.freeze({
    name: 'Kaien Island',
    displayGroup: 'North Coast',
    suitability: 'Urban island containing Prince Rupert and its local park destinations.',
    bcgnNameId: 35382,
    bcgnFeatureId: 3651,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/35382.html',
    osmRelationId: 8399414,
    osmUrl: 'https://www.openstreetmap.org/relation/8399414',
  }),
  Object.freeze({
    name: 'Calvert Island',
    displayGroup: 'Central Coast',
    suitability: 'Prominent coastal wilderness and access point for the Hakai region.',
    bcgnNameId: 26741,
    bcgnFeatureId: 31674,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/26741.html',
    osmRelationId: 2144098,
    osmUrl: 'https://www.openstreetmap.org/relation/2144098',
  }),
  Object.freeze({
    name: 'Campbell Island',
    displayGroup: 'Central Coast',
    suitability: 'Inhabited island containing Bella Bella.',
    bcgnNameId: 29032,
    bcgnFeatureId: 3311,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/29032.html',
    osmRelationId: 2144099,
    osmUrl: 'https://www.openstreetmap.org/relation/2144099',
  }),
  Object.freeze({
    name: 'Denny Island',
    displayGroup: 'Central Coast',
    suitability: 'Inhabited island with Shearwater and the historic Bella Bella site.',
    bcgnNameId: 14488,
    bcgnFeatureId: 21267,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/14488.html',
    osmRelationId: 2144100,
    osmUrl: 'https://www.openstreetmap.org/relation/2144100',
  }),
  Object.freeze({
    name: 'Swindle Island',
    displayGroup: 'Central Coast',
    suitability: 'Inhabited central-coast island containing the Klemtu community.',
    bcgnNameId: 30868,
    bcgnFeatureId: 35142,
    bcgnUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/30868.html',
    osmRelationId: 2144150,
    osmUrl: 'https://www.openstreetmap.org/relation/2144150',
  }),
]);
