const fs = require('fs');
const path = require('path');
const escapeHtml = require('escape-html');

const normalizeSlashes = (function() {
  const backslashRE = /\\/g;
  return function normalizeSlashes(pathname) {
    return pathname.replace(backslashRE, '/');
  };
}());

const formatBytes = (function() {
  const k = 1024;
  const sizes = ['B', 'K', 'M', 'G'];
  return function formatBytes(bytes, decimals = 0) {
    const ndx = Math.min(Math.log(bytes) / Math.log(k) | 0, sizes.length - 1);
    return `${(bytes / Math.pow(k, ndx)).toFixed(decimals)}${sizes[ndx]}`;
  };
}());

// Important! This is currently hacked to match what Kodi expects
// See https://github.com/xbmc/xbmc/blob/master/xbmc/filesystem/HTTPDirectory.cpp
// and https://github.com/greggman/servez-lib/pull/3
function createHtmlFileList(files, dir) {
  const noStat =  {
    isDirectory() { return false; },
    mtime: new Date(0),
    size: 0,
  };
  return `<table id="files">${
    files.map(file => {      
      const stat = file.stat || noStat;
      const isDir = stat.isDirectory();

      const pathname = encodeURIComponent(file.name);

      const endSlash = isDir ? '/' : '';
      const url = `${escapeHtml(pathname)}${endSlash}`;
      const displayName = `${escapeHtml(file.name)}${endSlash}`;

      const d = stat.mtime;
      const monthStr = ("0" + (d.getMonth() + 1)).slice(-2);
      const dayStr = ("0" + d.getDate()).slice(-2);
      const yearStr = d.getFullYear();
      const timeStr = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
      const dateStr = `${yearStr}-${monthStr}-${dayStr} ${timeStr}`;
      const sizeStr = isDir
          ? '-'
          : `${formatBytes(stat.size, 1)}`;

      return `<tr>
        <td class="i"></td>
        <td class="n"><a href="${url}">${displayName}</a></td>
        <td align="right">${dateStr} </td>
        <td class="s">${sizeStr}</td>
      </tr>`.replace(/\n/g, '')  // because Kodi splits by line
      // note: kodi need the align="right" and the space after the date!??!
    }).join('\n')
  }</table>`;
}

function htmlPath(dir) {
  var parts = dir.split('/');
  var crumb = new Array(parts.length);

  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];

    if (part) {
      parts[i] = encodeURIComponent(part);
      crumb[i] = '<a href="' + escapeHtml(parts.slice(0, i + 1).join('/')) + '">' + escapeHtml(part) + '</a>';
    }
  }

  return crumb.join(' / ');
}

const template = path.join(__dirname, '..', 'src', 'listing.html');

module.exports = function createHtmlRender() {
  return function render(locals, callback) {
    // read template
    fs.readFile(template, 'utf8', function (err, str) {
      if (err) return callback(err);

      var body = str
        .replace(/\{files\}/g, createHtmlFileList(locals.fileList, locals.directory, locals.displayIcons, locals.viewName))
        .replace(/\{directory\}/g, escapeHtml(locals.directory))
        .replace(/\{linked-path\}/g, htmlPath(locals.directory));

      callback(null, body);
    });
  };
}
