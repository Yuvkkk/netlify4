const fetch = require("node-fetch");
const crypto = require("crypto");

const accountId = process.env.B2_ACCOUNT_ID;
const applicationKey = process.env.B2_APPLICATION_KEY;
const authUrl = "https://api.backblazeb2.com/b2api/v2/b2_authorize_account";
const MIN_PART_SIZE = 5 * 1000 * 1000; // 5MB

let tempBuffers = {};
let fileIds = {};

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  const token = event.headers.authorization?.split(" ")[1];
  if (token !== process.env.API_TOKEN) {
    console.error("授权失败: 无效的 token");
    return { statusCode: 403, body: JSON.stringify({ message: "Unauthorized" }) };
  }

  if (event.httpMethod !== "POST") {
    console.error("方法不支持:", event.httpMethod);
    return { statusCode: 405, body: JSON.stringify({ message: "Method Not Allowed" }) };
  }

  console.log("收到请求: [长度]", event.body.length);
  try {
    if (!event.body) throw new Error("请求体为空");
    const body = JSON.parse(event.body);
    const { file, fileName, mimeType, partNumber, totalParts, fileId: incomingFileId } = body;

    if (!file || !fileName || !totalParts) {
      throw new Error("缺少必要参数: file, fileName 或 totalParts");
    }

    const fileBuffer = Buffer.from(file, "base64");
    console.log(`文件: ${fileName}, 大小: ${fileBuffer.length} 字节, totalParts: ${totalParts}, partNumber: ${partNumber || "N/A"}`);

    const authResponse = await fetch(authUrl, {
      headers: {
        Authorization: "Basic " + Buffer.from(`${accountId}:${applicationKey}`).toString("base64"),
      },
    });
    const authData = await authResponse.json();
    if (!authResponse.ok) throw new Error(`授权失败: ${JSON.stringify(authData)}`);
    const { authorizationToken, apiUrl } = authData;
    console.log("授权成功");

    if (totalParts === 1) {
      const uploadUrlResponse = await fetch(`${apiUrl}/b2api/v2/b2_get_upload_url`, {
        method: "POST",
        headers: { Authorization: authorizationToken, "Content-Type": "application/json" },
        body: JSON.stringify({ bucketId: "5f4a78ff70c84f6f94510519" }),
      });
      const uploadUrlData = await uploadUrlResponse.json();
      if (!uploadUrlResponse.ok) throw new Error(`获取上传 URL 失败: ${JSON.stringify(uploadUrlData)}`);
      const { uploadUrl, authorizationToken: uploadAuthToken } = uploadUrlData;

      const uploadResponse = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: uploadAuthToken,
          "Content-Type": mimeType || "application/octet-stream",
          "X-Bz-File-Name": encodeURIComponent(fileName),
          "X-Bz-Content-Sha1": "do_not_verify",
          "Content-Length": fileBuffer.length,
        },
        body: fileBuffer,
      });
      const uploadText = await uploadResponse.text();
      if (!uploadResponse.ok) throw new Error(`上传失败: ${uploadText}`);

      console.log("小文件上传成功:", fileName);
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "File uploaded successfully",
          fileUrl: `${apiUrl}/file/my-free-storage/${encodeURIComponent(fileName)}`,
        }),
      };
    }

    let fileId = incomingFileId || fileIds[fileName];

    if (partNumber === 1 && !fileId) {
      const startLargeFileResponse = await fetch(`${apiUrl}/b2api/v2/b2_start_large_file`, {
        method: "POST",
        headers: { Authorization: authorizationToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          bucketId: "5f4a78ff70c84f6f94510519",
          fileName: encodeURIComponent(fileName),
          contentType: mimeType || "application/octet-stream",
        }),
      });
      const startLargeFileData = await startLargeFileResponse.json();
      if (!startLargeFileResponse.ok) throw new Error(`启动大文件失败: ${JSON.stringify(startLargeFileData)}`);
      fileId = startLargeFileData.fileId;
      fileIds[fileName] = fileId;
      console.log("启动大文件上传成功:", fileId);
    }

    if (!fileId) {
      throw new Error("无效的 fileId");
    }

    // 暂存分片
    if (!tempBuffers[fileName]) tempBuffers[fileName] = [];
    tempBuffers[fileName].push(fileBuffer);
    const currentSize = tempBuffers[fileName].reduce((sum, buf) => sum + buf.length, 0);
    console.log(`暂存分片 ${partNumber}, 当前累计大小: ${currentSize} 字节`);

    // 每累计 2 片或到达最后一片时上传
    if (tempBuffers[fileName].length >= 2 || partNumber === totalParts) {
      const mergedBuffer = Buffer.concat(tempBuffers[fileName]);
      console.log(`合并分片，准备上传到 B2，大小: ${mergedBuffer.length} 字节`);

      const uploadPartUrlResponse = await fetch(`${apiUrl}/b2api/v2/b2_get_upload_part_url`, {
        method: "POST",
        headers: { Authorization: authorizationToken, "Content-Type": "application/json" },
        body: JSON.stringify({ fileId }),
      });
      const uploadPartUrlData = await uploadPartUrlResponse.json();
      if (!uploadPartUrlResponse.ok) throw new Error(`获取分片 URL 失败: ${JSON.stringify(uploadPartUrlData)}`);
      const { uploadUrl, authorizationToken: partAuthToken } = uploadPartUrlData;

      const partIndex = Math.ceil(partNumber / 2);
      const sha1 = crypto.createHash("sha1").update(mergedBuffer).digest("hex");
      console.log(`上传分片 ${partIndex} 到 B2，大小: ${mergedBuffer.length} 字节`);
      const uploadPartResponse = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: partAuthToken,
          "Content-Type": "b2/x-auto",
          "X-Bz-Part-Number": partIndex,
          "X-Bz-Content-Sha1": sha1,
          "Content-Length": mergedBuffer.length.toString(),
        },
        body: mergedBuffer,
      });
      const uploadPartText = await uploadPartResponse.text();
      if (!uploadPartResponse.ok) throw new Error(`分片上传失败: ${uploadPartText}`);
      console.log(`分片 ${partIndex} 上传成功`);

      // 清空暂存
      tempBuffers[fileName] = [];

      if (partNumber === totalParts) {
        const listPartsResponse = await fetch(`${apiUrl}/b2api/v2/b2_list_parts`, {
          method: "POST",
          headers: { Authorization: authorizationToken, "Content-Type": "application/json" },
          body: JSON.stringify({
            fileId,
            startPartNumber: 1,
            maxPartCount: 1000,
          }),
        });
        const listPartsData = await listPartsResponse.json();
        if (!listPartsResponse.ok) throw new Error(`列出分片失败: ${JSON.stringify(listPartsData)}`);
        const partSha1Array = listPartsData.parts.map((part) => part.contentSha1);
        console.log("已上传分片:", JSON.stringify(listPartsData.parts));

        const finishLargeFileResponse = await fetch(`${apiUrl}/b2api/v2/b2_finish_large_file`, {
          method: "POST",
          headers: { Authorization: authorizationToken, "Content-Type": "application/json" },
          body: JSON.stringify({
            fileId,
            partSha1Array,
          }),
        });
        const finishData = await finishLargeFileResponse.json();
        if (!finishLargeFileResponse.ok) throw new Error(`完成大文件失败: ${JSON.stringify(finishData)}`);
        console.log("大文件上传完成:", fileName);

        delete tempBuffers[fileName];
        delete fileIds[fileName];

        return {
          statusCode: 200,
          body: JSON.stringify({
            message: "File uploaded successfully",
            fileUrl: `${apiUrl}/file/my-free-storage/${encodeURIComponent(fileName)}`,
          }),
        };
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Part ${partNumber} received successfully`,
        fileId,
      }),
    };
  } catch (error) {
    console.error("处理失败:", error.message, error.stack);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Error uploading file", error: error.message }),
    };
  }
};
