package com.windock.app

/**
 * A small JSON reader/writer for the saved-computers list. android.jar's org.json
 * is a stub in JVM unit tests, and adding a JSON library is not worth it for one
 * flat list of strings and numbers. Values: Map<String, Any?>, List<Any?>, String,
 * Long, Double, Boolean, null.
 */
object MiniJson {
    fun write(value: Any?): String = StringBuilder().also { append(it, value) }.toString()

    private fun append(out: StringBuilder, value: Any?) {
        when (value) {
            null -> out.append("null")
            is String -> quote(out, value)
            is Boolean -> out.append(value)
            is Int, is Long -> out.append(value.toString())
            is Number -> value.toDouble().let { require(it.isFinite()); out.append(it) }
            is Map<*, *> -> {
                out.append('{')
                var first = true
                for ((k, v) in value) {
                    if (!first) out.append(',')
                    first = false
                    quote(out, k.toString()); out.append(':'); append(out, v)
                }
                out.append('}')
            }
            is List<*> -> {
                out.append('[')
                value.forEachIndexed { i, v -> if (i > 0) out.append(','); append(out, v) }
                out.append(']')
            }
            else -> throw IllegalArgumentException("unsupported JSON value")
        }
    }

    private fun quote(out: StringBuilder, s: String) {
        out.append('"')
        for (c in s) when {
            c == '"' -> out.append("\\\"")
            c == '\\' -> out.append("\\\\")
            c == '\n' -> out.append("\\n")
            c == '\r' -> out.append("\\r")
            c == '\t' -> out.append("\\t")
            c < ' ' || c == ' ' || c == ' ' -> out.append("\\u%04x".format(c.code))
            else -> out.append(c)
        }
        out.append('"')
    }

    /** Parses one JSON document; throws IllegalArgumentException on malformed input. */
    fun parse(text: String): Any? {
        val p = Parser(text)
        val value = p.value(0)
        p.skipWs()
        require(p.i == text.length) { "trailing data" }
        return value
    }

    private class Parser(val s: String) {
        var i = 0
        fun skipWs() { while (i < s.length && s[i] in " \t\r\n") i++ }
        private fun fail(): Nothing = throw IllegalArgumentException("bad JSON at $i")

        fun value(depth: Int): Any? {
            if (depth > 32) fail()
            skipWs()
            if (i >= s.length) fail()
            return when (s[i]) {
                '{' -> obj(depth)
                '[' -> arr(depth)
                '"' -> str()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> num()
            }
        }

        private fun literal(word: String, v: Any?): Any? {
            if (!s.startsWith(word, i)) fail()
            i += word.length
            return v
        }

        private fun obj(depth: Int): Map<String, Any?> {
            val out = LinkedHashMap<String, Any?>()
            i++; skipWs()
            if (i < s.length && s[i] == '}') { i++; return out }
            while (true) {
                skipWs()
                if (i >= s.length || s[i] != '"') fail()
                val key = str()
                skipWs()
                if (i >= s.length || s[i] != ':') fail()
                i++
                out[key] = value(depth + 1)
                skipWs()
                if (i >= s.length) fail()
                when (s[i]) { ',' -> i++; '}' -> { i++; return out }; else -> fail() }
            }
        }

        private fun arr(depth: Int): List<Any?> {
            val out = ArrayList<Any?>()
            i++; skipWs()
            if (i < s.length && s[i] == ']') { i++; return out }
            while (true) {
                out.add(value(depth + 1))
                skipWs()
                if (i >= s.length) fail()
                when (s[i]) { ',' -> i++; ']' -> { i++; return out }; else -> fail() }
            }
        }

        private fun str(): String {
            val out = StringBuilder()
            i++
            while (true) {
                if (i >= s.length) fail()
                val c = s[i++]
                when {
                    c == '"' -> return out.toString()
                    c == '\\' -> {
                        if (i >= s.length) fail()
                        when (val e = s[i++]) {
                            '"', '\\', '/' -> out.append(e)
                            'b' -> out.append('\b'); 'f' -> out.append('\u000c')
                            'n' -> out.append('\n'); 'r' -> out.append('\r'); 't' -> out.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) fail()
                                out.append(s.substring(i, i + 4).toIntOrNull(16)?.toChar() ?: fail())
                                i += 4
                            }
                            else -> fail()
                        }
                    }
                    c < ' ' -> fail()
                    else -> out.append(c)
                }
            }
        }

        private fun num(): Any {
            val start = i
            if (i < s.length && s[i] == '-') i++
            while (i < s.length && (s[i].isDigit() || s[i] in ".eE+-")) i++
            val text = s.substring(start, i)
            if (text.isEmpty() || text == "-") fail()
            return text.toLongOrNull() ?: text.toDoubleOrNull()?.takeIf { it.isFinite() } ?: fail()
        }
    }
}
