import { expect } from 'chai';
import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseEphemerisFile, generateOEMTBuffer, generateOEMTFiles } from '../parse.mjs';

describe('Ephemeris File Processing', () => {
    const inputDir = './test/data';
    const outputDir = './test/output';

    before(() => {
        if (!existsSync(outputDir)) {
            mkdirSync(outputDir);
        }
    });

    afterEach(() => {
        const files = readdirSync(outputDir);
        files.forEach(file => unlinkSync(join(outputDir, file)));
    });

    it('should parse the ephemeris file correctly', () => {
        const filePath = join(inputDir, 'test_ephemeris.txt');
        const { metadata, ephemerisData, covarianceData } = parseEphemerisFile(filePath);

        expect(metadata).to.have.property('created');
        expect(metadata).to.have.property('ephemeris_start');
        expect(metadata).to.have.property('ephemeris_stop');
        expect(metadata).to.have.property('step_size');
        expect(metadata).to.have.property('ephemeris_source');
        expect(ephemerisData).to.be.an('array').that.is.not.empty;
        expect(covarianceData).to.be.an('array').that.is.not.empty;
    });

    it('should generate a valid OEMT buffer', () => {
        const filePath = join(inputDir, 'test_ephemeris.txt');
        const { metadata, ephemerisData, covarianceData } = parseEphemerisFile(filePath);
        const oemBuffer = generateOEMTBuffer(metadata, ephemerisData, covarianceData);

        expect(oemBuffer).to.be.instanceOf(Uint8Array);
        expect(oemBuffer.length).to.be.greaterThan(0);
    });

    it('should generate OEMT files for all ephemeris files in the directory', () => {
        generateOEMTFiles(inputDir, outputDir);
        const outputFiles = readdirSync(outputDir).filter(file => file.endsWith('.oem'));

        const inputFiles = readdirSync(inputDir).filter(file => file.endsWith('.txt'));
        expect(outputFiles.length).to.equal(inputFiles.length);
    });

    after(() => {
        const files = readdirSync(outputDir);
        files.forEach(file => unlinkSync(join(outputDir, file)));
    });
});

// Run the tests
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('mocha').run();
