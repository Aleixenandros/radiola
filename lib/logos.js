// SPDX-License-Identifier: Apache-2.0
//
// Logos chosen by the user for their own stations. The image is copied to
// ~/.local/share/radiola/logos, so it keeps working if the original file
// is moved or deleted. Used by the preferences window; only GLib and Gio.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

/** Logos are small pictures; anything bigger is surely a mistake. */
export const MAX_LOGO_SIZE = 2 * 1024 * 1024;

export function logosDir() {
    return Gio.File.new_for_path(
        GLib.build_filenamev([GLib.get_user_data_dir(), 'radiola', 'logos']));
}

/**
 * Turn what the user typed into a logo file, if it is a local one.
 *
 * @param {string} text a path, a file:// URI or anything else
 * @returns {Gio.File|null} the file, or null if the text is not local
 */
export function localLogoFile(text) {
    const value = text.trim();
    if (value.startsWith('file://'))
        return Gio.File.new_for_uri(value);
    if (value.startsWith('/') || value.startsWith('~/'))
        return Gio.File.new_for_path(value.replace(/^~(?=\/)/, GLib.get_home_dir()));
    return null;
}

/**
 * Copy a logo into the logos folder, named after its content so the same
 * image is stored only once.
 *
 * @param {Gio.File} file the image chosen by the user
 * @returns {Promise<string>} the file:// URI of the copy
 */
export async function copyLogo(file) {
    const dir = logosDir();
    if (file.has_parent(dir))
        return file.get_uri();

    const [contents] = await file.load_contents_async(null);
    if (contents.length === 0 || contents.length > MAX_LOGO_SIZE)
        throw new Error(`Unusable logo size: ${contents.length} bytes`);

    const extension = (file.get_basename().match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? 'png').toLowerCase();
    const name = `${GLib.compute_checksum_for_data(GLib.ChecksumType.SHA1, contents)}.${extension}`;
    const copy = dir.get_child(name);

    GLib.mkdir_with_parents(dir.get_path(), 0o755);
    if (!copy.query_exists(null)) {
        await copy.replace_contents_bytes_async(new GLib.Bytes(contents), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }
    return copy.get_uri();
}
