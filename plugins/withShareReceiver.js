/**
 * 接收系统「分享」进来的内容。
 *
 * 为什么必须动原生：`ACTION_SEND` 不是 URL，`expo-linking` 拿不到；
 * Expo 也没有内置的分享接收模块。这里用最小侵入的方式做：
 *
 * 1. manifest 里给 MainActivity 加 `ACTION_SEND` 的 intent-filter；
 * 2. 在 `MainActivity` 里注入一小段 Kotlin：把分享进来的**文字**和**文件**
 *    落到 App 私有目录（`filesDir/incoming/`），写一份 `incoming-share.json`；
 * 3. JS 侧读那个目录，转成一条草稿或走已有的导入链路。
 *
 * 为什么在原生就把文件复制走：`content://` 的读权限跟着 Activity 走，
 * 用户切走或进程被回收后就打不开了。等 JS 再回来读，多半已经失败。
 *
 * 不改 launchMode、不新增 Activity：MainActivity 是 `singleTask`，
 * 已经开着时分享进来会走 `onNewIntent`，所以两条路都要接。
 */
const { withAndroidManifest, withMainActivity } = require('expo/config-plugins');

/**
 * 能接的类型。
 *
 * `image/*` 留通配：微信里「用其他应用打开」有时不报准确 mime。
 * Office 那几种必须逐个写全 —— 微信分享 docx 时报的是
 * `application/vnd.openxmlformats-officedocument.wordprocessingml.document`，
 * 只声明 `application/*` 反而会让碎片出现在一堆不相干的「打开方式」里。
 *
 * **没做的**：`application/octet-stream`。部分机型上微信对未知后缀会报这个，
 * 收下它等于让碎片对任何二进制文件都出现。等真机上确认确实遇到再放开。
 */
const MIME = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'image/*',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];
const INCOMING_DIR = 'incoming';

const KOTLIN_IMPORTS = `import android.content.Intent
import android.net.Uri
import java.io.File`;

const KOTLIN_BODY = `
  /**
   * 分享进来那条 Uri 的**真实文件名**。
   *
   * 微信给的是 \`content://\` 形式的 Uri，它的 lastPathSegment 往往是一串数字 id，
   * 直接拿来当文件名会丢掉扩展名 —— 文档库里就会多一条既读不了也认不出类型的记录。
   * \`OpenableColumns.DISPLAY_NAME\` 才是系统保存的原始名字（中文也在）。
   */
  private fun displayNameOf(uri: Uri): String? {
    if (uri.scheme != "content") return null
    return try {
      contentResolver.query(
        uri,
        arrayOf(android.provider.OpenableColumns.DISPLAY_NAME),
        null, null, null,
      )?.use { cursor ->
        if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getString(0) else null
      }
    } catch (e: Exception) {
      null
    }
  }

  /** 磁盘名只用字母数字和 . _ -；\`isLetterOrDigit\` 认 Unicode，中文不会被吃掉 */
  private fun safeDiskName(name: String): String = name.map { ch ->
    if (ch.isLetterOrDigit() || ch == '.' || ch == '_' || ch == '-') ch else '_'
  }.joinToString("")

  /**
   * 复制一条 uri 进私有目录，返回 (磁盘名, 原名)。失败返回 null。
   *
   * 为什么要 index 前缀：多选时同一次分享里可能有两个同名的 \`报告.pdf\`，
   * 只靠时间戳会把后一个覆盖掉，用户以为「只存进去一份」。
   */
  private fun saveStream(uri: Uri, dir: File, stamp: Long, index: Int, fallback: String?): Pair<String, String>? {
    return try {
      val name = displayNameOf(uri)
        ?: fallback
        ?: uri.lastPathSegment?.substringAfterLast('/')
        ?: "share-$index.bin"
      val target = File(dir, "$stamp-$index-" + safeDiskName(name))
      contentResolver.openInputStream(uri)?.use { input ->
        target.outputStream().use { output -> input.copyTo(output) }
      }
      Pair(target.name, name)
    } catch (e: Exception) {
      // 复制失败就跳过这一个文件；不因为一张图把整次分享丢掉
      null
    }
  }

  /**
   * 把分享进来的文字与文件落到私有目录，JS 只读本地（见 src/shareInbox.ts）。
   *
   * 单选（ACTION_SEND）给的是 EXTRA_STREAM 一个 Uri；多选（ACTION_SEND_MULTIPLE）
   * 给的是同一个 key 下的 ArrayList<Uri>。两条都要接 —— 相册里一次选三张图
   * 走的就是多选，只接单选的话那三张会全部丢掉。
   *
   * 同一个时间戳写进 json 和文件名，JS 靠它判断「是不是同一次分享」，
   * 避免把上一次留下的文件当成这次的内容。
   *
   * \`files[].file\` 是磁盘上的名字（ASCII 安全化过），\`files[].name\` 是给人看的原名 ——
   * 两者必须分开：中文文件名换了安全字符之后在文档库里就是一片下划线。
   */
  /**
   * 文件的字节数。取不到就返回 null —— 不因为量不出大小把整次分享拒掉。
   * OpenableColumns.SIZE 在部分 provider 上是 -1，这里统一当「不知道」。
   */
  private fun sizeOf(uri: Uri): Long? = try {
    contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length }?.takeIf { it >= 0L }
  } catch (e: Exception) {
    null
  }

  private fun captureShare(incoming: Intent?) {
    val action = incoming?.action ?: return
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return

    val stamp = System.currentTimeMillis()
    val dir = File(filesDir, "${INCOMING_DIR}")
    if (!dir.exists()) dir.mkdirs()

    val text = incoming.getStringExtra(Intent.EXTRA_TEXT) ?: ""
    val mime = incoming.type ?: ""
    val single = action == Intent.ACTION_SEND

    val uris: List<Uri> = if (single) {
      listOfNotNull(incoming.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
    } else {
      incoming.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: emptyList()
    }
    // EXTRA_TITLE 只对单选有意义（多选时它是整次分享的标题，不是文件名）
    val fallback = if (single) incoming.getStringExtra(Intent.EXTRA_TITLE) else null
    if (text.isEmpty() && uris.isEmpty()) return

    /*
     * 先写一份「复制中」的占位，JS 看到 copying=true 会等最终文件列表。
     * 复制放后台线程：一个几百 MB 的文件同步 copyTo 会把主线程卡到 ANR。
     */
    val placeholder = org.json.JSONObject()
    placeholder.put("at", stamp)
    placeholder.put("mime", mime)
    placeholder.put("text", text)
    placeholder.put("copying", true)
    placeholder.put("files", org.json.JSONArray())
    File(dir, "incoming-share.json").writeText(placeholder.toString())

    Thread {
      val maxFiles = 20
      val maxFileBytes = 200L * 1024L * 1024L
      val maxTotalBytes = 500L * 1024L * 1024L
      val files = org.json.JSONArray()
      val skipped = org.json.JSONArray()
      var total = 0L
      try {
        uris.forEachIndexed { index, uri ->
          val shown = displayNameOf(uri) ?: ("文件 " + (index + 1))
          if (index >= maxFiles) {
            skipped.put(org.json.JSONObject().put("name", shown).put("reason", "一次最多接 20 份"))
            return@forEachIndexed
          }
          val size = sizeOf(uri)
          if (size != null && size > maxFileBytes) {
            skipped.put(org.json.JSONObject().put("name", shown).put("reason", "单份超过 200 MB"))
            return@forEachIndexed
          }
          if (size != null && total + size > maxTotalBytes) {
            skipped.put(org.json.JSONObject().put("name", shown).put("reason", "合计超过 500 MB"))
            return@forEachIndexed
          }
          val saved = saveStream(uri, dir, stamp, index, fallback)
          if (saved == null) {
            skipped.put(org.json.JSONObject().put("name", shown).put("reason", "复制失败"))
            return@forEachIndexed
          }
          if (size != null) total += size
          files.put(
            org.json.JSONObject()
              .put("file", saved.first)
              .put("name", saved.second),
          )
        }
      } catch (e: Exception) {
        skipped.put(org.json.JSONObject().put("name", "分享").put("reason", e.message ?: "复制失败"))
      }

      val json = org.json.JSONObject()
      json.put("at", stamp)
      json.put("mime", mime)
      json.put("text", text)
      json.put("copying", false)
      json.put("files", files)
      json.put("skipped", skipped)
      File(dir, "incoming-share.json").writeText(json.toString())
    }.start()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    captureShare(intent)
  }
`;

module.exports = function withShareReceiver(config) {
  // ---- 1. manifest：ACTION_SEND + 各类型 ----
  config = withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (!app) throw new Error('withShareReceiver: manifest 里没有 application');
    const activity = (app.activity || []).find(
      (a) => String(a.$['android:name']).endsWith('.MainActivity'),
    );
    if (!activity) throw new Error('withShareReceiver: 找不到 MainActivity');

    activity['intent-filter'] = activity['intent-filter'] || [];
    const has = activity['intent-filter'].some((f) =>
      (f.action || []).some((a) => a.$['android:name'] === 'android.intent.action.SEND_MULTIPLE'),
    );
    if (!has) {
      activity['intent-filter'].push({
        // 两个 action 共用一个 filter：相册一次选多张走的是 SEND_MULTIPLE，
        // 只声明 SEND 的话那些图根本不会出现在「分享到碎片」里
        action: [
          { $: { 'android:name': 'android.intent.action.SEND' } },
          { $: { 'android:name': 'android.intent.action.SEND_MULTIPLE' } },
        ],
        category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
        data: MIME.map((mimeType) => ({ $: { 'android:mimeType': mimeType } })),
      });
    }
    return cfg;
  });

  // ---- 2. MainActivity：注入接收逻辑 ----
  config = withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') {
      throw new Error('withShareReceiver: MainActivity 不是 Kotlin，注入逻辑要改');
    }
    let src = cfg.modResults.contents;

    if (!src.includes('captureShare')) {
      // import
      src = src.replace('import android.os.Bundle', `import android.os.Bundle\n${KOTLIN_IMPORTS}`);
      // onCreate 里先收分享，再设主题（顺序无所谓，但都在 super 之前更安全）
      src = src.replace(
        '    setTheme(R.style.AppTheme);',
        '    captureShare(intent)\n    setTheme(R.style.AppTheme);',
      );
      // 类结束前加方法与 onNewIntent
      const end = src.lastIndexOf('}');
      src = `${src.slice(0, end)}${KOTLIN_BODY}${src.slice(end)}`;
    }

    cfg.modResults.contents = src;
    return cfg;
  });

  return config;
};
