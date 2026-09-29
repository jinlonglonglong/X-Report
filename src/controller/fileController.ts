import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import path from "path";
import fs from 'fs';
import { ZipArchive } from 'archiver';
import * as dotenv from "dotenv";
import { batchQueryXPosts } from '../xsearch/batchXPostSearch.ts';

dotenv.config();

const FILES_DIR = path.join(process.cwd(), 'src', 'files');

interface ReportRequest {
  field: string;
  keyWords: string[];
}

export default async function fileController(fastify: FastifyInstance) {
  /**
 * GET /api/files/download
 *
 * 将本地 files 目录下的所有文件
 * 打包成 ZIP，然后以 Stream 的方式返回。
 */
  fastify.get(
    "/download",
    async (_request, reply) => {
      // 检查目录是否存在
      if (!fs.existsSync(FILES_DIR)) {
        return reply.code(404).send({
          message: 'Files directory not found'
        })
      }

      // 创建 ZIP
      const archive = new ZipArchive({
        zlib: {
          level: 6
        }
      });

      // ZIP 出错
      archive.on('error', (error) => {
        fastify.log.error(error)
      })

      // 获取目录中的文件
      const files = await fs.promises.readdir(FILES_DIR, {
        withFileTypes: true
      })

      // 只处理文件
      const normalFiles = files.filter(
        (file) => file.isFile()
      )

      if (normalFiles.length === 0) {
        return reply.code(404).send({
          message: 'No files found'
        })
      }

      archive.directory(
        FILES_DIR,
        false
      );

      // 设置 HTTP Response
      reply
        .code(200)
        .type('application/zip')
        .header(
          'Content-Disposition',
          'attachment; filename="files.zip"'
        )

      // 直接把 ZIP Stream 返回
      const response = reply.send(archive);

      // 开始压缩
      await archive.finalize();

      return response;
    }

  );


  fastify.post(
    '/report',
    async (
      request: FastifyRequest<{
        Body: ReportRequest
      }>,
      reply: FastifyReply
    ) => {

      const {
        field,
        keyWords
      } = request.body

      console.log('field:', field)
      console.log('keyWords:', keyWords)
       // 1. 动态计算时间范围（当前时间 往后推 24 小时）
    const now = new Date();
    const future = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // 严格格式化时间为 YYYY-MM-DD 格式（例如：2026-09-22）
    const formatDate = (date: Date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    const fromDate = formatDate(now);      // 当前日期 2026-09-22
    const toDate = formatDate(future);     // 24小时后 2026-09-23

      const result = await batchQueryXPosts({
        domain: field,
        keywords: keyWords,
        fromDate: fromDate,
        toDate: toDate,
        xaiOptions: {
          apiKey: process.env.Grok_Key,
          baseURL: process.env.Grok_Url,
          model: process.env.Grok_Model
        }
      });

      return reply.send({
        success: true,
        result
      })
    }
  )
}
