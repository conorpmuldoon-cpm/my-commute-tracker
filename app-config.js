// A client ID and hosted-layer URLs are public configuration, not secrets.
// Never add an OAuth client secret, API key, or access token to this file.
export const appConfig = {
  portalUrl: "https://prof-services.maps.arcgis.com",
  clientId: "sy4ZkZXZccP0PyVM",
  redirectUrl: "https://conorpmuldoon-cpm.github.io/my-commute-tracker/oauth-callback.html",
  featureLayerUrl: "https://services1.arcgis.com/wQnFk5ouCfPzTlPw/arcgis/rest/services/My_Commutes/FeatureServer/0",
  sampleLayerUrl: "https://services1.arcgis.com/wQnFk5ouCfPzTlPw/arcgis/rest/services/Commute_Samples/FeatureServer/0",
  speedSegmentsLayerUrl: "https://services1.arcgis.com/wQnFk5ouCfPzTlPw/arcgis/rest/services/Commute_Speed_Segments/FeatureServer/0"
};
