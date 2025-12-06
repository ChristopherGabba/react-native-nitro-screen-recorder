/**
 * FileManager contains static *awaitable* file-system functions
 */
export declare class FileManager {
    static readFile(path: string): Promise<string>;
    static writeFile(path: string, contents: string): Promise<void>;
    static copyFile(path1: string, path2: string): Promise<void>;
    static dirExists(path: string): boolean;
}
