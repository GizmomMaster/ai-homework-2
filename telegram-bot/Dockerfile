FROM node:20-alpine

WORKDIR /app

# У адаптера нет внешних зависимостей — только встроенные модули Node.js,
# поэтому ни npm install, ни компиляторов здесь не требуется.
COPY package.json ./
COPY src ./src

# Порт, на который Core доставляет готовые ответы. Наружу не публикуется:
# он нужен только внутри compose-сети.
EXPOSE 8081

CMD ["node", "src/index.js"]
