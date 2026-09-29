import type { FastifyInstance } from "fastify";
import userController from "./controller/userController.ts";
import indexController from "./controller/indexController.ts";
import fileController from "./controller/fileController.ts";

export default async function router(fastify: FastifyInstance) {
  fastify.register(userController, { prefix: "/api/v1/user" });
  fastify.register(indexController, { prefix: "/" });
  fastify.register(fileController, { prefix: "/api/v1/files" });
}
