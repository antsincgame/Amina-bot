FROM nginx:alpine
COPY index.html /usr/share/nginx/html/index.html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Replace endpoint placeholder at container start
CMD sh -c "sed -i \"s|%%APPWRITE_ENDPOINT%%|${APPWRITE_ENDPOINT:-https://appwrite.vibecoding.by/v1}|g\" /usr/share/nginx/html/index.html && nginx -g 'daemon off;'"
