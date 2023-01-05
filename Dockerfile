FROM debian:bullseye as builder

ARG NODE_VERSION=16.17.0
ARG YARN_VERSION=1.22.19

RUN apt-get update; apt install -y curl git openssh-client openssh-server
RUN mkdir ~/.ssh && chmod 0700 ~/.ssh && ssh-keyscan github.com >> ~/.ssh/known_hosts
RUN curl https://get.volta.sh | bash
ENV VOLTA_HOME /root/.volta
ENV PATH /root/.volta/bin:$PATH
RUN volta install node@${NODE_VERSION} yarn@${YARN_VERSION}

#######################################################################

RUN mkdir /app
WORKDIR /app

COPY . .

RUN yarn install --network-concurrency 1 && yarn run build
FROM debian:bullseye

LABEL fly_launch_runtime="nodejs"

COPY --from=builder /root/.volta /root/.volta
COPY --from=builder /app /app

WORKDIR /app
ENV NODE_ENV production
ENV PATH /root/.volta/bin:$PATH

CMD [ "node", "out/index.js" ]
