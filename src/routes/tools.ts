import type { FastifyPluginAsync } from 'fastify'
import { getBuiltinSchemas } from '../tools/index.js'

const toolsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/v1/tools', async () => ({
    object: 'list',
    data: getBuiltinSchemas(),
  }))
}

export default toolsRoute
