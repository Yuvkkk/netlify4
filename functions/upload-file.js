const fetch = require("node-fetch");
const { IncomingForm } = require("formidable");

const accountId = "005fa8f08ff41590000000002";
const applicationKey = "K005rTY6c7IuYqYDDdYQbhlCEc9qy3Y";
const authUrl = "https://api.backblazeb2.com/b2api/v2/b2_authorize_account";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  console.log("收到请求头:", event.headers);
  try {
    // 解析 multipart/form-data
    const form = new IncomingForm();
    const [fields, files] = await new Promise((resolve, reject) => {
      form.parse({ headers: event.headers, body: Buffer.from(event.body, "base64") }, (err, fields, files) => {
        if (err) reject(err);
        else resolve([fields, files]);
      });
    });

    const file = files.file[0]; // 获取第一个文件
    if (!file) {
      console.log("错误: 缺少文件");
      return { statusCode: 400, body: JSON.stringify({ message: "缺少文件" }) };
    }

    console.log("文件信息:", file.originalFilename, file.mimetype);
    const authResponse = await fetch(authUrl, {
      method: "GET",
      headers: {
        Authorization: "Basic " + Buffer.from(`${accountId}:${applicationKey}`).toString("base64"),
      },
    });
    const authData = await authResponse.json();
    if (!authResponse.ok) throw new Error(JSON.stringify(authData));
    const { authorizationToken, apiUrl } = authData;
    console.log("B2 授权成功", { authorizationToken, apiUrl });

    const uploadUrlResponse = await fetch(`${apiUrl}/b2api/v2/b2_get_upload_url`, {
      method: "POST",
      headers: {
        Authorization: authorizationToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bucketId: "5f4a78ff70c84f6f94510519" }),
    });
    const uploadUrlData = await uploadUrlResponse.json();
    if (!uploadUrlResponse.ok) throw new Error(JSON.stringify(uploadUrlData));
    const { uploadUrl, authorizationToken: uploadAuthToken } = uploadUrlData;
    console.log("获取上传 URL 成功:", uploadUrl);

    const fileBuffer = require("fs").readFileSync(file.filepath); // 读取文件二进制
    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: uploadAuthToken,
        "Content-Type": file.mimetype || "application/octet-stream",
        "X-Bz-File-Name": encodeURIComponent(file.originalFilename),
        "X-Bz-Content-Sha1": "do_not_verify",
      },
      body: fileBuffer,
    });
    if (!uploadResponse.ok) throw new Error(await uploadResponse.text());
    console.log("上传成功:", file.originalFilename);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "File uploaded successfully",
        fileUrl: `${apiUrl}/file/my-free-storage/${encodeURIComponent(file.originalFilename)}`,
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