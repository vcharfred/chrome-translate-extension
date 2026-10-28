/**
 * 口令派生与加解密（Web Crypto）
 * 仅被后台 Service Worker 通过 importScripts 加载，
 * 口令与明文密钥都只在后台内存中出现，不写日志、不外传。
 */

var KDF_ITER = 200000;
var SALT_LEN = 16;
var IV_LEN = 12;

function toB64(buf) {
  var bytes = new Uint8Array(buf);
  var s = "";
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(str) {
  var bin = atob(str);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function deriveKey(pass, saltB64, iter) {
  var enc = new TextEncoder();
  return crypto.subtle
    .importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"])
    .then(function (baseKey) {
      return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: fromB64(saltB64), iterations: iter || KDF_ITER, hash: "SHA-256" },
        baseKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );
    });
}

/** 用口令加密字符串，返回可安全落盘的密文对象 */
function encryptString(pass, plain) {
  var salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  var iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  var saltB64 = toB64(salt);
  return deriveKey(pass, saltB64, KDF_ITER)
    .then(function (key) {
      return crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        key,
        new TextEncoder().encode(plain)
      );
    })
    .then(function (data) {
      return { salt: saltB64, iv: toB64(iv), data: toB64(data), iter: KDF_ITER };
    });
}

/** 用口令解密；口令错误时 reject（AES-GCM 认证标签校验失败） */
function decryptString(pass, encObj) {
  return deriveKey(pass, encObj.salt, encObj.iter || KDF_ITER)
    .then(function (key) {
      return crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64(encObj.iv) },
        key,
        fromB64(encObj.data)
      );
    })
    .then(function (buf) {
      return new TextDecoder().decode(buf);
    });
}
