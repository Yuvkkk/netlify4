const fetch = require("node-fetch");
const crypto = require("crypto");

const accountId = process.env.B2_ACCOUNT_ID;
const applicationKey = process.env.B2_APPLICATION_KEY;
const authUrl = "https://api.backblazeb2.com/b2api/v2/b2_authorize_account";
const PART_SIZE = 5 * 1024 * 1024;
const CHUNK_SIZE = 4 * 1024 * 1024;

const uploadSessions = new Map();

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  const token = event.headers.authorization?.split(" ")[1];
  if (token !== process.env.API_TOKEN) {
    return { statusCode: 403, body: JSON.stringify({ message: "Unauthorized" }) };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ message: "Method Not Allowed" }) };
  }

  console.log("收到请求: [长度]", event.body.length);
  try {
    if (!event.body) throw new Error("请求体为空");
    const body = JSON.parse(event.body);
    const { file, fileName, mimeType, partNumber, totalParts, fileId: incomingFileId } = body;

    if (!file || !fileName || !totalParts) {
      throw new Error("缺少必要参数");
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
        },
        body: fileBuffer,
      });
      if (!uploadResponse.ok) throw new Error(`上传失败: ${await uploadResponse.text()}`);

      console.log("小文件上传成功:", fileName);
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "File uploaded successfully",
          fileUrl: `${apiUrl}/file/my-free-storage/${encodeURIComponent(fileName)}`,
        }),
      };
    }

    let fileId = incomingFileId;
    let session = uploadSessions.get(fileName) || { fileId: null, parts: [], tempBuffer: [], tempSize: 0 };

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
      session.fileId = fileId;
      uploadSessions.set(fileName, session);
      console.log("启动大文件上传成功:", fileId);
    }

    if (!fileId || !session.fileId) {
      throw new Error("无效的 fileId 或会话");
    }

    session.tempBuffer.push(fileBuffer);
    session.tempSize += fileBuffer.length;
    console.log(`暂存分片 ${partNumber}, 当前累计大小: ${session.tempSize} 字节`);

    if (session.tempSize >= PART_SIZE || partNumber === totalParts) {
      const combinedBuffer = Buffer.concat(session.tempBuffer);
      console.log(`合并分片，准备上传到 B2，大小: ${combinedBuffer.length} 字节`);

      const uploadPartUrlResponse = await fetch(`${apiUrl}/b2api/v2/b2_get_upload_part_url`, {
        method: "POST",
        headers: { Authorization: authorizationToken, "Content-Type": "application/json" },
        body: JSON.stringify({ fileId }),
      });
      const uploadPartUrlData = await uploadPartUrlResponse.json();
      if (!uploadPartUrlResponse.ok) throw new Error(`获取分片 URL 失败: ${JSON.stringify(uploadPartUrlData)}`);
      const { uploadUrl, authorizationToken: partAuthToken } = uploadPartUrlData;

      const sha1 = crypto.createHash("sha1").update(combinedBuffer).digest("hex");
      const actualPartNumber = session.parts.length + 1;
      const uploadPartResponse = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: partAuthToken,
          "Content-Type": "b2/x-auto",
          "X-Bz-Part-Number": actualPartNumber,
          "X-Bz-Content-Sha1": sha1,
          "Content-Length": combinedBuffer.length,
        },
        body: combinedBuffer,
      });
      if (!uploadPartResponse.ok) throw new Error(`分片上传失败: ${await uploadPartResponse.text()}`);
      session.parts.push({ partNumber: actualPartNumber, sha1 });
      console.log(`分片 ${actualPartNumber} 上传成功`);

      session.tempBuffer = [];
      session.tempSize = 0;
      uploadSessions.set(fileName, session);
    }

    if (partNumber === totalParts) {
      const finishLargeFileResponse = await fetch(`${apiUrl}/b2api/v2/b2_finish_large_file`, {
        method: "POST",
        headers: { Authorization: authorizationToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          fileId,
          partSha1Array: session.parts.sort((a, b) => a.partNumber - b.partNumber).map((p) => p.sha1),
        }),
      });
      if (!finishLargeFileResponse.ok) throw new Error(`完成大文件失败: ${await finishLargeFileResponse.text()}`);
      uploadSessions.delete(fileName);
      console.log("大文件上传完成:", fileName);

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "File uploaded successfully",
          fileUrl: `${apiUrl}/file/my-free-storage/${encodeURIComponent(fileName)}`,
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Part ${partNumber} received successfully`,
        fileId,
      }),
    };
  } catch (error) {
    console.error("处理失败:", error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Error uploading file", error: error.message }),
    };
  }
};
