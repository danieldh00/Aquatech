// Uitgaande verbindingen naar adressen die een beheerder van een organisatie
// zelf invult (webshop, mailserver) mogen niet naar het eigen netwerk van de
// server: anders kan een tenant via de app het lokale netwerk aftasten.
// Daarom de naam eerst opzoeken en alleen openbare adressen toestaan; de
// verbinding gaat daarna naar precies dat adres.
const dns = require('dns').promises;
const net = require('net');

// Twee lijsten: een IPv6-regel als ::ffff:0:0/96 zou in één lijst ook elk
// IPv4-adres blokkeren.
const blocked4 = new net.BlockList();
const blocked6 = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked4.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked6.addSubnet(addr, prefix, 'ipv6');

/**
 * Of lokale adressen toch mogen (ALLOW_PRIVATE_HOSTS=1, alleen voor tests/ontwikkelen).
 * @returns {boolean} true als lokale adressen zijn toegestaan.
 */
const privateAllowed = () => process.env.ALLOW_PRIVATE_HOSTS === '1';

/**
 * Of een IP-adres openbaar is (niet lokaal, privé, gereserveerd of multicast).
 * @param {string} ip Een IPv4- of IPv6-adres.
 * @returns {boolean} true bij een openbaar adres; false bij een privé adres of iets dat geen IP-adres is.
 */
function isPublicAddress(ip) {
  const ipVersion = net.isIP(ip);
  if (!ipVersion) return false;
  return ipVersion === 6 ? !blocked6.check(ip, 'ipv6') : !blocked4.check(ip, 'ipv4');
}

class PrivateHostError extends Error {
  /**
   * Fout als een host naar een niet-openbaar adres wijst (code 'private_host').
   * @param {string} host De opgezochte hostnaam.
   */
  constructor(host) {
    super(`${host} is geen openbaar adres.`);
    this.code = 'private_host';
  }
}

/**
 * Zoekt een hostnaam op en geeft het eerste adres terug, maar alleen als álle
 * adressen openbaar zijn. De verbinding gaat daarna naar precies dat adres.
 * @param {string} host Hostnaam of IP-adres (IPv6 mag tussen [ ]).
 * @param {{ lookup?: Function }} [options] Eigen DNS-opzoekfunctie (voor tests).
 * @returns {Promise<string>} Het openbare IP-adres.
 * @throws {PrivateHostError} Als een adres niet openbaar is.
 */
async function publicAddress(host, { lookup = dns.lookup } = {}) {
  const name = String(host || '').replace(/^\[|\]$/g, '');
  const addrs = net.isIP(name) ? [name] : (await lookup(name, { all: true, verbatim: true })).map((entry) => entry.address);
  if (!addrs.length || !addrs.every(isPublicAddress)) throw new PrivateHostError(name);
  return addrs[0];
}

module.exports = { publicAddress, isPublicAddress, privateAllowed, PrivateHostError };
