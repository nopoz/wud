/**
 * Semver utils.
 */
const semver = require('semver');
const log = require('../log');

/**
 * Parse a string to a semver (return null is it cannot be parsed as a valid semver).
 * @param rawVersion
 * @returns {*|SemVer}
 */
function parse(rawVersion) {
    const rawVersionCleaned = semver.clean(rawVersion, { loose: true });
    const rawVersionSemver = semver
        .parse(rawVersionCleaned !== null ? rawVersionCleaned : rawVersion);
    // Hurrah!
    if (rawVersionSemver !== null) {
        return rawVersionSemver;
    }

    // Last chance; try to coerce (all data behind patch digit will be lost).
    return semver.coerce(rawVersion);
}

/**
 * Return true if version1 is semver greater than version2.
 * @param version1
 * @param version2
 */
function isGreater(version1, version2) {
    const version1Semver = parse(version1);
    const version2Semver = parse(version2);

    // No comparison possible
    if (version1Semver === null || version2Semver === null) {
        return false;
    }
    return semver.gte(version1Semver, version2Semver);
}

/**
 * Diff between 2 semver versions.
 * @param version1
 * @param version2
 * @returns {*|string|null}
 */
function diff(version1, version2) {
    const version1Semver = parse(version1);
    const version2Semver = parse(version2);

    // No diff possible
    if (version1Semver === null || version2Semver === null) {
        return null;
    }
    return semver.diff(version1Semver, version2Semver);
}

/**
 * Transform a tag using a formula.
 * @param transformFormula
 * @param originalTag
 * @return {*}
 */
function transform(transformFormula, originalTag) {
    if (!transformFormula || transformFormula === '') {
        return originalTag;
    }
    try {
        const transformFormulaSplit = transformFormula.split(/\s*=>\s*/);
        const transformRegex = new RegExp(transformFormulaSplit[0]);
        const placeholders = transformFormulaSplit[1].match(/\$\d+/g);
        const originalTagMatches = originalTag.match(transformRegex);

        if (!originalTagMatches) {
            log.warn(`Tag [${originalTag}] does not match the transformation regex [${transformRegex}]. Returning original tag.`);
            return originalTag;
        }

        let transformedTag = transformFormulaSplit[1];
        placeholders.forEach((placeholder) => {
            const placeholderIndex = Number.parseInt(placeholder.substring(1), 10);
            transformedTag = transformedTag.replace(new RegExp(placeholder.replace('$', '\\$'), 'g'), originalTagMatches[placeholderIndex]);
        });
        return transformedTag;
    } catch (e) {
        log.warn(`Error when applying transform function [${transformFormula}] to tag [${originalTag}]`);
        log.debug(e);
        return originalTag;
    }
}

module.exports = {
    parse,
    isGreater,
    diff,
    transform,
};
