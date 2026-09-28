import { standards, writeFB, readFB } from 'spacedatastandards.org';
export { readFB };
const record = (Type, fields) => Object.assign(new Type(), fields);
export function ommBytes(elements) {
  // Serialization only; every orbital value comes from WASM or SupGP.
  const row = new standards.OMM.OMMT();
  for (const key of Object.keys(row)) if (elements[key] !== undefined && typeof elements[key] !== 'object') row[key] = elements[key];
  row.CCSDS_OMM_VERS = 2;
  row.TIME_SYSTEM = standards.OMM.timingStandard.UTC;
  row.MEAN_ELEMENT_THEORY = standards.OMM.meanElementSource.SGP4;
  row.CENTER_NAME = 'EARTH';
  row.REFERENCE_FRAME = new standards.OMM.RFMT(standards.OMM.RFMUnion.CustomFrameWrapper,
    new standards.OMM.CustomFrameWrapperT(standards.OMM.CustomFrame.TEME), 0, 'TEME');
  // These are the WASM output / SupGP convention labels, not frame conversions.
  return writeFB(row);
}
export function textFitProducts(fit) {
  const s = standards.OCM;
  const params = ['MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE',
    'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR'].map(key => record(s.UserDefinedParametersT,
    { PARAM_NAME: key, PARAM_VALUE: String(fit[key]) }));
  params.push(record(s.UserDefinedParametersT, { PARAM_NAME: 'COVARIANCE_STATUS', PARAM_VALUE: 'Unavailable on OD text result port' }));
  const ocm = record(s.OCMT, {
    HEADER: record(s.HeaderT, { CCSDS_OCM_VERS: '3.0', CREATION_DATE: new Date().toISOString(), ORIGINATOR: 'test-retriever',
      COMMENT: ['Mean elements copied from orbit-determination WASM result. No Cartesian states or raw ephemeris retained.'] }),
    METADATA: record(s.MetadataT, { OBJECT_NAME: fit.OBJECT_NAME, INTERNATIONAL_DESIGNATOR: fit.OBJECT_ID,
      OBJECT_DESIGNATOR: String(fit.NORAD_CAT_ID), CATALOG_NAME: 'NORAD' }),
    ORBIT_DETERMINATION: record(s.OrbitDeterminationT, { OD_METHOD: 'SGP4 differential correction', OD_EPOCH: fit.EPOCH,
      OD_RESIDUAL_RMS: Number(fit.RMS), OD_RESIDUALS: `RMS ${fit.RMS} km; source ${fit.DATA_SOURCE}` }),
    USER_DEFINED_PARAMETERS: params, ORB_AVERAGING: 'SGP4',
  });
  const obd = record(standards.OBD.OBDT, { SAT_NO: fit.NORAD_CAT_ID, ORIG_OBJECT_ID: fit.OBJECT_ID,
    START_TIME: fit.EPOCH, METHOD: standards.OBD.odMethod.DIFFERENTIAL_CORRECTION,
    METHOD_SOURCE: 'orbit-determination WASM; WRMS contains unweighted position RMS in km',
    WRMS: Number(fit.RMS), NUM_ITERATIONS: fit.ITERATIONS });
  return { omm: ommBytes(fit), ocm: writeFB(ocm), obd: writeFB(obd) };
}
