/*
 * The MIT License (MIT)
 *
 * Copyright (c) 2014 Yuya Tanaka
 * Kotlin port: 2025
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
package com.margelo.nitro.nitroscreenrecorder

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel

/**
 * Ported from qt-faststart.c, released in public domain.
 * Original Java implementation by Yuya Tanaka (ypresto).
 * Converted to Kotlin for react-native-nitro-screen-recorder.
 */
object QtFastStart {
    private const val ATOM_PREAMBLE_SIZE = 8

    // Top level atoms
    private val FREE_ATOM = fourCcToInt(byteArrayOf('f'.code.toByte(), 'r'.code.toByte(), 'e'.code.toByte(), 'e'.code.toByte()))
    private val JUNK_ATOM = fourCcToInt(byteArrayOf('j'.code.toByte(), 'u'.code.toByte(), 'n'.code.toByte(), 'k'.code.toByte()))
    private val MDAT_ATOM = fourCcToInt(byteArrayOf('m'.code.toByte(), 'd'.code.toByte(), 'a'.code.toByte(), 't'.code.toByte()))
    private val MOOV_ATOM = fourCcToInt(byteArrayOf('m'.code.toByte(), 'o'.code.toByte(), 'o'.code.toByte(), 'v'.code.toByte()))
    private val PNOT_ATOM = fourCcToInt(byteArrayOf('p'.code.toByte(), 'n'.code.toByte(), 'o'.code.toByte(), 't'.code.toByte()))
    private val SKIP_ATOM = fourCcToInt(byteArrayOf('s'.code.toByte(), 'k'.code.toByte(), 'i'.code.toByte(), 'p'.code.toByte()))
    private val WIDE_ATOM = fourCcToInt(byteArrayOf('w'.code.toByte(), 'i'.code.toByte(), 'd'.code.toByte(), 'e'.code.toByte()))
    private val PICT_ATOM = fourCcToInt(byteArrayOf('P'.code.toByte(), 'I'.code.toByte(), 'C'.code.toByte(), 'T'.code.toByte()))
    private val FTYP_ATOM = fourCcToInt(byteArrayOf('f'.code.toByte(), 't'.code.toByte(), 'y'.code.toByte(), 'p'.code.toByte()))
    private val UUID_ATOM = fourCcToInt(byteArrayOf('u'.code.toByte(), 'u'.code.toByte(), 'i'.code.toByte(), 'd'.code.toByte()))
    private val CMOV_ATOM = fourCcToInt(byteArrayOf('c'.code.toByte(), 'm'.code.toByte(), 'o'.code.toByte(), 'v'.code.toByte()))
    private val STCO_ATOM = fourCcToInt(byteArrayOf('s'.code.toByte(), 't'.code.toByte(), 'c'.code.toByte(), 'o'.code.toByte()))
    private val CO64_ATOM = fourCcToInt(byteArrayOf('c'.code.toByte(), 'o'.code.toByte(), '6'.code.toByte(), '4'.code.toByte()))

    private fun fourCcToInt(byteArray: ByteArray): Int {
        return ByteBuffer.wrap(byteArray).order(ByteOrder.BIG_ENDIAN).int
    }

    private fun uint32ToLong(int32: Int): Long {
        return int32.toLong() and 0x00000000ffffffffL
    }

    private fun uint32ToInt(uint32: Int): Int {
        if (uint32 < 0) {
            throw UnsupportedFileException("uint32 value is too large")
        }
        return uint32
    }

    private fun uint32ToInt(uint32: Long): Int {
        if (uint32 > Int.MAX_VALUE || uint32 < 0) {
            throw UnsupportedFileException("uint32 value is too large")
        }
        return uint32.toInt()
    }

    private fun uint64ToLong(uint64: Long): Long {
        if (uint64 < 0) throw UnsupportedFileException("uint64 value is too large")
        return uint64
    }

    private fun readAndFill(infile: FileChannel, buffer: ByteBuffer): Boolean {
        buffer.clear()
        val size = infile.read(buffer)
        buffer.flip()
        return size == buffer.capacity()
    }

    private fun readAndFill(infile: FileChannel, buffer: ByteBuffer, position: Long): Boolean {
        buffer.clear()
        val size = infile.read(buffer, position)
        buffer.flip()
        return size == buffer.capacity()
    }

    /**
     * Optimizes an MP4 file for streaming by moving the moov atom to the beginning.
     *
     * @param inputChannel Input file channel.
     * @param outputChannel Output file channel.
     * @return false if input file is already fast start, true if optimization was performed.
     * @throws IOException
     * @throws MalformedFileException
     * @throws UnsupportedFileException
     */
    fun fastStart(inputChannel: FileChannel, outputChannel: FileChannel): Boolean {
        val atomBytes = ByteBuffer.allocate(ATOM_PREAMBLE_SIZE).order(ByteOrder.BIG_ENDIAN)
        var atomType = 0
        var atomSize: Long = 0L
        val lastOffset: Long
        val moovAtom: ByteBuffer
        var ftypAtom: ByteBuffer? = null
        val moovAtomSize: Int
        var startOffset: Long = 0

        // Traverse through the atoms in the file to make sure that 'moov' is at the end
        while (readAndFill(inputChannel, atomBytes)) {
            atomSize = uint32ToLong(atomBytes.int)
            atomType = atomBytes.int

            // Keep ftyp atom
            if (atomType == FTYP_ATOM) {
                val ftypAtomSize = uint32ToInt(atomSize)
                ftypAtom = ByteBuffer.allocate(ftypAtomSize).order(ByteOrder.BIG_ENDIAN)
                atomBytes.rewind()
                ftypAtom.put(atomBytes)
                if (inputChannel.read(ftypAtom) < ftypAtomSize - ATOM_PREAMBLE_SIZE) break
                ftypAtom.flip()
                startOffset = inputChannel.position()
            } else {
                if (atomSize == 1L) {
                    // 64-bit special case
                    atomBytes.clear()
                    if (!readAndFill(inputChannel, atomBytes)) break
                    atomSize = uint64ToLong(atomBytes.long)
                    inputChannel.position(inputChannel.position() + atomSize - ATOM_PREAMBLE_SIZE * 2)
                } else {
                    inputChannel.position(inputChannel.position() + atomSize - ATOM_PREAMBLE_SIZE)
                }
            }

            if (atomType != FREE_ATOM &&
                atomType != JUNK_ATOM &&
                atomType != MDAT_ATOM &&
                atomType != MOOV_ATOM &&
                atomType != PNOT_ATOM &&
                atomType != SKIP_ATOM &&
                atomType != WIDE_ATOM &&
                atomType != PICT_ATOM &&
                atomType != UUID_ATOM &&
                atomType != FTYP_ATOM) {
                break
            }

            if (atomSize < 8) break
        }

        if (atomType != MOOV_ATOM) {
            // Last atom was not moov - file is already optimized or invalid
            return false
        }

        // Load the whole moov atom
        moovAtomSize = uint32ToInt(atomSize)
        lastOffset = inputChannel.size() - moovAtomSize
        moovAtom = ByteBuffer.allocate(moovAtomSize).order(ByteOrder.BIG_ENDIAN)
        if (!readAndFill(inputChannel, moovAtom, lastOffset)) {
            throw MalformedFileException("failed to read moov atom")
        }

        // Check for compressed atoms (not supported)
        if (moovAtom.getInt(12) == CMOV_ATOM) {
            throw UnsupportedFileException("this utility does not support compressed moov atoms yet")
        }

        // Crawl through the moov chunk in search of stco or co64 atoms
        while (moovAtom.remaining() >= 8) {
            val atomHead = moovAtom.position()
            atomType = moovAtom.getInt(atomHead + 4)
            if (atomType != STCO_ATOM && atomType != CO64_ATOM) {
                moovAtom.position(moovAtom.position() + 1)
                continue
            }
            atomSize = uint32ToLong(moovAtom.getInt(atomHead))
            if (atomSize > moovAtom.remaining()) {
                throw MalformedFileException("bad atom size")
            }
            moovAtom.position(atomHead + 12)
            if (moovAtom.remaining() < 4) {
                throw MalformedFileException("malformed atom")
            }
            val offsetCount = uint32ToInt(moovAtom.int)
            if (atomType == STCO_ATOM) {
                if (moovAtom.remaining() < offsetCount * 4) {
                    throw MalformedFileException("bad atom size/element count")
                }
                for (i in 0 until offsetCount) {
                    val currentOffset = moovAtom.getInt(moovAtom.position())
                    val newOffset = currentOffset + moovAtomSize
                    if (currentOffset < 0 && newOffset >= 0) {
                        throw UnsupportedFileException(
                            "stco atom should be extended to co64 atom as new offset value overflows uint32, " +
                            "but is not implemented."
                        )
                    }
                    moovAtom.putInt(newOffset)
                }
            } else if (atomType == CO64_ATOM) {
                if (moovAtom.remaining() < offsetCount * 8) {
                    throw MalformedFileException("bad atom size/element count")
                }
                for (i in 0 until offsetCount) {
                    val currentOffset = moovAtom.getLong(moovAtom.position())
                    moovAtom.putLong(currentOffset + moovAtomSize)
                }
            }
        }

        inputChannel.position(startOffset)

        // Write ftyp atom if it exists
        ftypAtom?.let {
            it.rewind()
            outputChannel.write(it)
        }

        // Write the new moov atom
        moovAtom.rewind()
        outputChannel.write(moovAtom)

        // Copy the remainder of the file
        inputChannel.transferTo(startOffset, lastOffset - startOffset, outputChannel)

        return true
    }

    open class QtFastStartException(message: String) : Exception(message)
    class MalformedFileException(message: String) : QtFastStartException(message)
    class UnsupportedFileException(message: String) : QtFastStartException(message)
}
